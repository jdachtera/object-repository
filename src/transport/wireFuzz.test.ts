/**
 * The wire is the trust boundary: whatever an authenticated client sends, it must not reach another
 * tenant's rows or a reserved model. This throws random and hostile requests — real victims' uuids
 * wrapped in arrays and objects, forged owners, reserved model names, malformed plans and paging,
 * unknown methods — at a `BackendAdapter` over a `PolicyBackend` with row-level security, as a third
 * tenant, and checks after every one that the adapter answered, the other tenants' rows are exactly as
 * they were, and nothing it returned belongs to them.
 *
 * `PROPERTY_RUNS` / `PROPERTY_SEED` as in the migration property suites.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { PolicyBackend, type AccessPolicy } from "../backends/decorators/PolicyBackend.js";
import { BackendAdapter } from "./BackendAdapter.js";
import { eq } from "../expressions/builders.js";
import type { Context, JsonObject } from "../core/types.js";
import type { WireRequest } from "../core/Transport.js";
import { BackendJournal } from "../migrations/journal.js";

const RUNS = Number(process.env.PROPERTY_RUNS ?? 200);
const SEED = process.env.PROPERTY_SEED === undefined ? undefined : Number(process.env.PROPERTY_SEED);

const ctxFor = (id: string): Context => ({ identity: { id } });
const ownerPolicy: AccessPolicy = {
  read: (_model, ctx) => eq("owner", ctx.identity ? ctx.identity.id : "__anonymous__"),
  write: (_model, record, ctx) => !!ctx.identity && record.owner === ctx.identity.id
};

const VICTIMS: JsonObject[] = [
  { uuid: "a1", owner: "alice", text: "alice's" },
  { uuid: "a2", owner: "alice", text: "alice's too" },
  { uuid: "b1", owner: "bob", text: "bob's" }
];
const VICTIM_UUIDS = VICTIMS.map((row) => String(row.uuid));

async function world() {
  const inner = new InMemoryBackend();
  for (const row of VICTIMS) inner.save("Note", { ...row }, ctxFor(String(row.owner)));
  await inner.persist(ctxFor("system"));
  // The journal: an applied migration whose raw SQL is the server's business, and a pending one.
  const journal = new BackendJournal(inner, ctxFor("system"));
  const sql = { kind: "rawSql" as const, statement: "GRANT ALL TO s3cr3t", params: [], dialect: "*" as const, phase: "expand" as const };
  const row = { version: 0, opsHash: "", cursor: null, appliedAt: 1 };
  await journal.write({ ...row, name: "0001_applied", phase: "expand", status: "applied", ops: [sql, { kind: "dropField", model: "Note", field: "old" }] });
  await journal.write({ ...row, name: "0002_pending", phase: "contract", status: "pending", ops: [sql] });
  return { inner, adapter: new BackendAdapter(new PolicyBackend(inner, ownerPolicy)) };
}

// --- hostile input --------------------------------------------------------------------------------

const victimUuid = fc.constantFrom(...VICTIM_UUIDS);
/** Every shape a uuid could take that a store might still turn into a victim's. */
// Weighted toward what an attacker would actually try: a victim's uuid in some disguise, sent as the
// caller's own record (which passes the write policy), against the real model.
const uuidLike = fc.oneof(
  { arbitrary: victimUuid, weight: 3 },
  { arbitrary: victimUuid.map((u) => [u]), weight: 3 },
  { arbitrary: victimUuid.map((u) => [[u]]), weight: 1 },
  { arbitrary: victimUuid.map((u) => ({ toString: u, $eq: u })), weight: 2 },
  { arbitrary: victimUuid.map((u) => ` ${u}`), weight: 1 },
  { arbitrary: fc.constantFrom("", null, undefined), weight: 1 },
  { arbitrary: fc.integer(), weight: 1 },
  { arbitrary: fc.string({ maxLength: 6 }), weight: 1 }
);
const owner = fc.oneof(
  { arbitrary: fc.constant("mallory"), weight: 6 },
  { arbitrary: fc.constantFrom("alice", "bob", undefined, ["mallory"], { $ne: "x" }), weight: 2 }
);
const modelName = fc.oneof(
  { arbitrary: fc.constant("Note"), weight: 6 },
  { arbitrary: fc.constantFrom("_object_repository_migration_log", "_outbox", "__proto__", "constructor", "Missing"), weight: 2 }
);

const record = fc.record(
  { uuid: uuidLike, owner, text: fc.oneof(fc.string({ maxLength: 8 }), fc.constant({ $set: { owner: "mallory" } })) },
  { requiredKeys: ["uuid", "owner"] }
);
const change = fc.record({ model: modelName, record });

/** Expression nodes, valid and not: the adapter must refuse or filter them, never leak through them. */
const node: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    fc.constant({ type: "all" }),
    fc.record({ type: fc.constant("compare"), property: fc.constantFrom("owner", "uuid", "text", "$where", "__proto__"), comparator: fc.constantFrom("=", "!=", ">", "<", "$ne"), value: fc.anything({ maxDepth: 1 }) }),
    fc.record({ type: fc.constantFrom("or", "and"), expressions: fc.array(tie("node"), { maxLength: 3 }) }),
    fc.record({ type: fc.constant("not"), expression: tie("node") }),
    fc.anything({ maxDepth: 2 })
  )
})).node;

const plan = fc.record(
  {
    model: modelName,
    where: node,
    order: fc.oneof(fc.constant([]), fc.array(fc.record({ property: fc.constantFrom("owner", "text", "uuid", "x;DROP"), descending: fc.boolean() }), { maxLength: 2 })),
    paging: fc.oneof(fc.constant({ start: 0 }), fc.record({ start: fc.integer({ min: -5, max: 5 }), end: fc.option(fc.integer({ min: -5, max: 10 }), { nil: undefined }) })),
    project: fc.option(fc.array(fc.constantFrom("owner", "text", "uuid", "__proto__"), { maxLength: 3 }), { nil: undefined })
  },
  { requiredKeys: ["model"] }
);

const request: fc.Arbitrary<WireRequest> = fc.oneof(
  fc.record({ method: fc.constant("persist"), params: fc.record({ saves: fc.array(change, { maxLength: 3 }), removes: fc.array(change, { maxLength: 3 }) }) }),
  fc.record({ method: fc.constantFrom("query", "queryUuids"), params: fc.record({ plan }) }),
  fc.record({ method: fc.constant("aggregate"), params: fc.record({ plan: fc.record({ model: modelName, where: node, groupBy: fc.constant([]), aggregates: fc.constant([{ kind: "count", as: "n" }]) }) }) }),
  fc.record({ method: fc.constantFrom("migrationState", "handshake", "command", "pull", "push", "drop", "__proto__"), params: fc.anything({ maxDepth: 2 }) }),
  fc.anything({ maxDepth: 3 })
) as fc.Arbitrary<WireRequest>;

// --- the property ---------------------------------------------------------------------------------

/** Every row in a response that isn't the caller's to see: another tenant's, or a reserved model's. */
function leaked(result: unknown, sent: WireRequest): unknown[] {
  const found: unknown[] = [];
  // A persist reply echoes the records the caller sent, uuids it chose included: judge it by owner only.
  const echo = (sent as { method?: unknown } | null)?.method === "persist";
  const victim = (value: unknown) => !echo && typeof value === "string" && VICTIM_UUIDS.includes(value);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      // A bare list of uuids (queryUuids).
      for (const item of value) if (victim(item)) found.push(item);
      return value.forEach(walk);
    }
    if (value === null || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (victim(row.uuid) || row.owner === "alice" || row.owner === "bob") found.push(row);
    Object.values(row).forEach(walk);
  };
  walk(result);
  // The journal's raw SQL, and its pending contract, are never a client's to read.
  if (JSON.stringify(result ?? null).includes("s3cr3t") || JSON.stringify(result ?? null).includes("0002_pending")) found.push("journal");
  return found;
}

describe("hostile requests over the wire, from a third tenant", () => {
  it("never reach another tenant's rows or a reserved model", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(request, { minLength: 1, maxLength: 4 }), async (requests) => {
        const { inner, adapter } = await world();
        for (const sent of requests) {
          let response: Awaited<ReturnType<BackendAdapter["handle"]>>;
          try {
            response = await adapter.handle(structuredClone(sent), ctxFor("mallory"));
          } catch (error) {
            throw new Error(`the adapter threw instead of answering: ${String(error)} for ${JSON.stringify(sent)}`);
          }
          if (response.ok) expect({ sent, leaked: leaked(response.result, sent) }).toEqual({ sent, leaked: [] });
        }
        // The other tenants' rows, and the journal, exactly as they were.
        const notes = await inner.query({ model: "Note", where: { type: "all" }, order: [{ property: "uuid", descending: false }], paging: { start: 0 } }, ctxFor("system"));
        expect(notes.filter((row) => row.owner !== "mallory")).toEqual(VICTIMS);
        const journal = await new BackendJournal(inner, ctxFor("system")).load();
        expect(journal.map((row) => `${row.name}:${row.status}`).sort()).toEqual(["0001_applied:applied", "0002_pending:pending"]);
      }),
      { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) }
    );
  }, 300_000);
});
