/**
 * Command middleware — the command-plane analogue of PolicyBackend. `use: [...]` guards run before the
 * handler: they can deny (throw → FORBIDDEN, or a CommandError to pick the code), augment the context
 * the handler sees, and short-circuit so the handler never runs. Covers the built-in `requireIdentity`
 * / `requireRole` and custom middleware.
 */
import { describe, it, expect } from "vitest";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { InProcessTransport } from "./InProcessTransport.js";
import { command, commandClient, requireIdentity, requireRole, CommandError, type CommandMiddleware } from "./command.js";
import type { Context } from "../core/types.js";

let handlerRuns = 0;

const commands = {
  whoami: command({
    use: [requireIdentity],
    handler: (_input, ctx) => {
      handlerRuns++;
      return ctx.identity!.id;
    }
  }),
  adminOnly: command({
    use: [requireRole("admin")],
    handler: () => {
      handlerRuns++;
      return "ok";
    }
  }),
  // a middleware that augments the context, which the handler then reads
  greetTenant: command({
    use: [(_input, ctx): Context => ({ ...ctx, scope: { tenant: "acme" } })],
    handler: (_input, ctx) => `tenant=${ctx.scope?.tenant as string}`
  }),
  // a guard that denies with a custom code, plus a plain-throw guard
  customDeny: command({
    use: [
      (): void => {
        throw new CommandError("TEAPOT", "no coffee here");
      }
    ],
    handler: () => "unreachable"
  }),
  plainDeny: command({
    use: [
      (): void => {
        throw new Error("nope");
      }
    ],
    handler: () => "unreachable"
  })
};

function client(ctx?: Context) {
  const transport = new InProcessTransport(new BackendAdapter(new InMemoryBackend(), undefined, commands));
  return commandClient<typeof commands>(transport, { context: ctx });
}

describe("command middleware / authorization", () => {
  it("requireIdentity denies an anonymous caller and admits an authenticated one", async () => {
    handlerRuns = 0;
    await expect(client().whoami(undefined)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(handlerRuns).toBe(0); // handler never ran

    expect(await client({ identity: { id: "u1" } }).whoami(undefined)).toBe("u1");
    expect(handlerRuns).toBe(1);
  });

  it("requireRole enforces roles", async () => {
    await expect(client({ identity: { id: "u1" } }).adminOnly(undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client().adminOnly(undefined)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await client({ identity: { id: "u1", roles: ["admin"] } }).adminOnly(undefined)).toBe("ok");
  });

  it("middleware can augment the context the handler receives", async () => {
    expect(await client({ identity: { id: "u1" } }).greetTenant(undefined)).toBe("tenant=acme");
  });

  it("a CommandError thrown in middleware keeps its code; a plain throw becomes FORBIDDEN", async () => {
    await expect(client().customDeny(undefined)).rejects.toMatchObject({ code: "TEAPOT", message: "no coffee here" });
    await expect(client().plainDeny(undefined)).rejects.toMatchObject({ code: "FORBIDDEN", message: "nope" });
  });

  it("runs guards in order and stops at the first denial", async () => {
    const calls: string[] = [];
    const trace =
      (name: string, deny = false): CommandMiddleware =>
      () => {
        calls.push(name);
        if (deny) throw new CommandError("FORBIDDEN", `${name} denied`);
      };
    const cmds = {
      guarded: command({ use: [trace("a"), trace("b", true), trace("c")], handler: () => "done" })
    };
    const transport = new InProcessTransport(new BackendAdapter(new InMemoryBackend(), undefined, cmds));
    await expect(commandClient<typeof cmds>(transport).guarded(undefined)).rejects.toMatchObject({ message: "b denied" });
    expect(calls).toEqual(["a", "b"]); // "c" never ran
  });
});
