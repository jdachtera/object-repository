/**
 * Typed commands — the task-based RPC seam that rides the existing transport (ARCHITECTURE.md §10).
 *
 * The `Backend` contract covers the *data plane* (typed queries + entity writes + sync). Commands are
 * the *command plane*: arbitrary server-side operations that aren't CRUD — `checkout`, `sendInvite`,
 * `regenerateKey` — with their own input/output types and side effects. They travel as a `command`
 * `WireRequest` over the *same* `Transport`, reusing its connection, the ambient `Context` (auth), and
 * any decorators, so a full-stack app needs one client↔server surface, not a parallel RPC stack.
 *
 * Integration with the data system: whatever a command's handler writes through the repositories (its
 * `persist`) emits change events on the server. Those events are captured and returned with the
 * reply, and the client feeds them back through the backend's change feed — so a mutation triggered by
 * a command invalidates the same query caches and drives the same reactive reloads as a normal write,
 * even over plain request/response HTTP with no live subscription.
 *
 * End-to-end types with no codegen: the server defines a command map (with handlers); the client
 * imports only its *type* (`import type`) and gets a fully-typed `client.checkout(input)`.
 */
import type { StandardSchemaV1 } from "../core/standardSchema.ts";
import type { ChangeEvent } from "../core/Backend.ts";
import type { Context } from "../core/types.ts";
import { SYSTEM_CONTEXT } from "../core/types.ts";
import type { Transport } from "../core/Transport.ts";
import { validateAsync, ValidationError } from "../properties/schema.ts";

/**
 * Command middleware — the command-plane analogue of `PolicyBackend`. Runs before the handler with
 * `(input, ctx)`; **throw** to deny (a plain throw becomes `FORBIDDEN`; throw a `CommandError` to pick
 * the code), or **return a `Context`** to augment what the rest of the chain and the handler see (e.g.
 * attach the loaded principal). Chained in declaration order.
 */
export type CommandMiddleware<In = unknown> = (input: In, ctx: Context) => void | Context | Promise<void | Context>;

/** A server-side command: validate `input` (optional Standard Schema), run `use` guards, then `handler`. */
export interface Command<In, Out> {
  /** Standard Schema for the input, validated on the server before the middleware/handler run. */
  input?: StandardSchemaV1<unknown, In>;
  /** Middleware run before the handler — authorization, rate limits, context augmentation. */
  use?: CommandMiddleware<In>[];
  handler: (input: In, ctx: Context) => Out | Promise<Out>;
}

/** Define a command. With an `input` schema, `In` is inferred from it (so `handler`'s input is typed). */
export function command<In, Out>(def: Command<In, Out>): Command<In, Out> {
  return def;
}

/** A named set of commands. The server registers this; the client is typed from `typeof` it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandMap = Record<string, Command<any, any>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InputOf<C> = C extends Command<infer In, any> ? In : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OutputOf<C> = C extends Command<any, infer Out> ? Awaited<Out> : never;

/**
 * The typed client surface derived from a command map — `{ [name]: (input) => Promise<output> }`.
 * Share the map's *type* with the client via `import type { AppCommands } from "./server"`.
 */
export type CommandClient<M extends CommandMap> = {
  [K in keyof M]: (input: InputOf<M[K]>) => Promise<OutputOf<M[K]>>;
};

/** A command's wire reply: the handler's return value plus the change events its writes produced. */
export interface CommandReply {
  value: unknown;
  changes: ChangeEvent[];
}

/** A backend that can accept change events observed out-of-band (implemented by `RemoteBackend`). */
export interface ChangeDeliverable {
  deliverChanges(events: ChangeEvent[]): void;
}

/** Narrow a backend to one that can receive command-reply change events. */
export function isChangeDeliverable(backend: object): backend is ChangeDeliverable {
  return typeof (backend as Partial<ChangeDeliverable>).deliverChanges === "function";
}

/** Thrown on the client when a command fails on the server (`code` is the server's error code). */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export interface CommandClientOptions {
  /** Ambient context sent with each call. Real auth usually rides the transport out-of-band (HTTP headers). */
  context?: Context;
  /** Receives the change events a command produced — wire this to your data system to invalidate caches. */
  onChanges?: (changes: ChangeEvent[]) => void;
}

/** Send one command over a transport, apply its change events via `onChanges`, and return the handler's value. */
export async function invokeCommand(
  transport: Transport,
  name: string,
  input: unknown,
  ctx: Context,
  onChanges?: (changes: ChangeEvent[]) => void
): Promise<unknown> {
  const response = await transport.request({ method: "command", params: { name, input } }, ctx);
  if (!response.ok) {
    throw new CommandError(response.error?.code ?? "COMMAND_ERROR", response.error?.message ?? "Command failed.");
  }
  const reply = response.result as CommandReply;
  if (reply.changes.length && onChanges) onChanges(reply.changes);
  return reply.value;
}

/**
 * A typed, ergonomic command client: `client.checkout(input)` dispatches the `checkout` command over
 * the transport. Type it with the server's command-map type — `commandClient<typeof commands>(transport)`.
 */
export function commandClient<M extends CommandMap>(transport: Transport, options: CommandClientOptions = {}): CommandClient<M> {
  const ctx = options.context ?? SYSTEM_CONTEXT;
  return new Proxy({} as CommandClient<M>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      return (input: unknown) => invokeCommand(transport, name, input, ctx, options.onChanges);
    }
  });
}

/**
 * Server-side: look up the command, validate its input, and run the handler — returning the handler's
 * value or throwing a `CommandError` (unknown command / invalid input) or the handler's own error. The
 * `BackendAdapter` wraps this with change capture and wire encoding.
 */
export async function executeCommand(commands: CommandMap, name: unknown, input: unknown, ctx: Context): Promise<unknown> {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(commands, name)) {
    throw new CommandError("UNKNOWN_COMMAND", `No command named ${JSON.stringify(name)}.`);
  }
  const cmd = commands[name]!;
  let validated: unknown = input;
  if (cmd.input) {
    try {
      validated = await validateAsync(cmd.input, input);
    } catch (error) {
      throw new CommandError("INVALID_INPUT", error instanceof ValidationError ? error.message : String(error));
    }
  }
  // Middleware chain: each may deny (throw) or augment the context passed downstream.
  let ctxForHandler = ctx;
  for (const middleware of cmd.use ?? []) {
    try {
      const augmented = await middleware(validated, ctxForHandler);
      if (augmented) ctxForHandler = augmented;
    } catch (error) {
      // A plain throw from a guard reads as a denial; a CommandError keeps its explicit code.
      if (error instanceof CommandError) throw error;
      throw new CommandError("FORBIDDEN", error instanceof Error ? error.message : String(error));
    }
  }
  return cmd.handler(validated, ctxForHandler);
}

/** Middleware: require an authenticated principal (`ctx.identity`). */
export const requireIdentity: CommandMiddleware = (_input, ctx) => {
  if (!ctx.identity) throw new CommandError("UNAUTHENTICATED", "This command requires authentication.");
};

/** Middleware: require the principal to hold at least one of `roles` (implies `requireIdentity`). */
export function requireRole(...roles: string[]): CommandMiddleware {
  return (_input, ctx) => {
    if (!ctx.identity) throw new CommandError("UNAUTHENTICATED", "This command requires authentication.");
    const held = ctx.identity.roles ?? [];
    if (!roles.some((role) => held.includes(role))) {
      throw new CommandError("FORBIDDEN", `This command requires one of the roles: ${roles.join(", ")}.`);
    }
  };
}
