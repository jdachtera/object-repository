/**
 * Typed commands (the command plane) over the transport. Covers dispatch + inferred result types,
 * input validation, error codes, context propagation, and — the headline — that a command's data
 * mutation flows back through the change feed to invalidate the client's query cache, even over a
 * request/response transport with no live subscription.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { RemoteBackend } from "./RemoteBackend.js";
import { RepositoryManager } from "../repository/RepositoryManager.js";
import { command, commandClient, CommandError } from "./command.js";
import { text } from "../properties/factories.js";
import type { Transport, WireRequest, WireResponse } from "../core/Transport.js";
import type { Context } from "../core/types.js";

const commands = {
  greet: command({
    input: z.object({ name: z.string() }),
    handler: (input) => `Hello, ${input.name}!` // input inferred as { name: string }
  }),
  whoami: command({ handler: (_input, ctx: Context) => ctx.identity?.id ?? "anon" }),
  boom: command({
    handler: (): string => {
      throw new Error("kaboom"); // a generic (unexpected) failure — must NOT leak to the client
    }
  }),
  refuse: command({
    handler: (): string => {
      throw new CommandError("FORBIDDEN", "you may not do that"); // a deliberate, client-facing error
    }
  })
};

/** In-process client wired to the command map, under a given request context. */
function client(ctx?: Context) {
  const transport = new InProcessTransport(new BackendAdapter(new InMemoryBackend(), undefined, commands));
  return commandClient<typeof commands>(transport, { context: ctx });
}

describe("typed commands", () => {
  it("dispatches a command and returns the handler's (typed) result", async () => {
    const greeting = await client().greet({ name: "Ada" });
    expect(greeting).toBe("Hello, Ada!"); // greeting is typed `string`
  });

  it("validates input against the command's schema", async () => {
    // @ts-expect-error — name must be a string
    await expect(client().greet({ name: 123 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("surfaces an unknown command", async () => {
    const anyClient = client() as unknown as { nope: (input: unknown) => Promise<unknown> };
    await expect(anyClient.nope({})).rejects.toMatchObject({ code: "UNKNOWN_COMMAND" });
  });

  it("wraps a generic handler error as an OPAQUE COMMAND_ERROR (no internal message leak)", async () => {
    const failing = client().boom(undefined);
    await expect(failing).rejects.toBeInstanceOf(CommandError);
    // the raw "kaboom" must not reach the client — only a generic message does
    await expect(failing).rejects.toMatchObject({ code: "COMMAND_ERROR" });
    await expect(failing).rejects.not.toMatchObject({ message: expect.stringContaining("kaboom") });
  });

  it("passes a deliberate CommandError (code + message) straight through to the client", async () => {
    const refused = (client() as unknown as { refuse: (i: unknown) => Promise<unknown> }).refuse(undefined);
    await expect(refused).rejects.toMatchObject({ code: "FORBIDDEN", message: "you may not do that" });
  });

  it("reports UNSUPPORTED_METHOD when the adapter has no commands", async () => {
    const transport = new InProcessTransport(new BackendAdapter(new InMemoryBackend()));
    const bare = commandClient<typeof commands>(transport);
    await expect(bare.greet({ name: "x" })).rejects.toMatchObject({ code: "UNSUPPORTED_METHOD" });
  });

  it("passes the request context to the handler", async () => {
    expect(await client({ identity: { id: "user-1" } }).whoami(undefined)).toBe("user-1");
    expect(await client().whoami(undefined)).toBe("anon");
  });
});

/** A request/response transport with no `subscribe` — so the only way changes reach the client is a command reply. */
class RequestOnlyTransport implements Transport {
  constructor(private readonly adapter: BackendAdapter) {}
  async request(op: WireRequest, ctx: Context): Promise<WireResponse> {
    const wire = JSON.parse(JSON.stringify(op)) as WireRequest;
    const response = await this.adapter.handle(wire, ctx);
    return JSON.parse(JSON.stringify(response)) as WireResponse;
  }
}

describe("commands integrate with the data system", () => {
  it("a command mutation invalidates the client's query cache without a live subscription", async () => {
    // --- server: real backend + repositories the command handler writes through ---
    const server = new InMemoryBackend();
    const serverOrm = new RepositoryManager({ backend: server });
    const serverUsers = serverOrm.define({ name: "User", properties: { name: text() } });
    const cmds = {
      addUser: command({
        input: z.object({ name: z.string() }),
        handler: async (input) => {
          const user = serverUsers.createInstance({ name: input.name });
          serverUsers.save(user);
          await serverUsers.persist(); // emits a change event, captured into the command reply
          return user.uuid;
        }
      })
    };
    const transport = new RequestOnlyTransport(new BackendAdapter(server, undefined, cmds));

    // --- client: same model over a RemoteBackend, plus the typed command client ---
    const clientOrm = new RepositoryManager({ backend: new RemoteBackend(transport, server.capabilities) });
    const clientUsers = clientOrm.define({ name: "User", properties: { name: text() } });
    const client_ = clientOrm.commands<typeof cmds>(transport);

    expect(await clientUsers.all().list()).toHaveLength(0); // caches the (empty) result

    await client_.addUser({ name: "Ada" }); // the reply's change event invalidates the client cache
    expect((await clientUsers.all().list()).map((u) => u.name)).toEqual(["Ada"]); // refetched

    // A mutation NOT routed through a command has no channel to the client (no subscription) → stale.
    serverUsers.save(serverUsers.createInstance({ name: "Bob" }));
    await serverUsers.persist();
    expect((await clientUsers.all().list()).map((u) => u.name)).toEqual(["Ada"]); // still cached

    // The next command invalidates again — and the refetch now also picks up Bob.
    await client_.addUser({ name: "Cy" });
    expect((await clientUsers.all().list()).map((u) => u.name).sort()).toEqual(["Ada", "Bob", "Cy"]);
  });
});
