import { describe, it, expect } from "vitest";
import { z } from "zod";
import { text, integer, json } from "./factories.js";
import { ValidationError } from "./schema.js";

// Zod (>= 3.24) implements Standard Schema natively, so a Zod schema can be handed straight to
// a property with no adapter. This is the "pluggable validators" guarantee from ARCHITECTURE.md §5.
describe("pluggable validators via Standard Schema (Zod)", () => {
  it("tightens a text property with a Zod refinement", () => {
    const email = text({ schema: z.string().email() });
    expect(email.validate("a@b.com")).toBe("a@b.com");
    expect(() => email.validate("not-an-email")).toThrow(ValidationError);
  });

  it("constrains an integer with Zod", () => {
    const age = integer({ schema: z.number().int().min(0) });
    expect(age.validate(5)).toBe(5);
    expect(() => age.validate(-1)).toThrow(ValidationError);
  });

  it("validates a structured json property and infers its type from the schema", () => {
    const schema = z.object({ bio: z.string() });
    const profile = json({ schema });
    expect(profile.validate({ bio: "x" })).toEqual({ bio: "x" });
    expect(() => profile.validate({ bio: 1 })).toThrow(ValidationError);

    // `profile` is ScalarProperty<{ bio: string }, string> — the runtime type follows the schema.
    const decoded = profile.decode(profile.encode({ bio: "y" }));
    expect(decoded.bio).toBe("y");
  });

  it("json(schema) — the positional form (parity with embedded) infers the type and validates", () => {
    // A discriminated union is inferred intact and enforced on write.
    const event = json(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("click"), x: z.number() }),
        z.object({ kind: z.literal("key"), code: z.string() })
      ])
    );
    expect(event.validate({ kind: "click", x: 1 })).toEqual({ kind: "click", x: 1 });
    expect(() => event.validate({ kind: "click", x: "nope" })).toThrow(ValidationError);
    expect(() => event.validate({ kind: "scroll" })).toThrow(ValidationError);

    // the inferred runtime type discriminates at compile time
    const e = event.validate({ kind: "key", code: "Enter" });
    if (e.kind === "key") expect(e.code).toBe("Enter");
    // @ts-expect-error — `x` doesn't exist on the "key" variant
    void (e.kind === "key" && e.x);
  });
});
