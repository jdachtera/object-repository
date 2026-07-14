/**
 * Compile-time assertions for `InferModel`. This file has no runtime; it fails the build
 * (`tsc --noEmit`) if model-type inference regresses, so the end-to-end typing guarantee is
 * enforced in CI rather than only documented.
 */
import {
  text,
  integer,
  float,
  boolean,
  date,
  json,
  relationToOne,
  relationToMany
} from "./factories.ts";
import type { InferModel } from "./infer.ts";

// Exact type equality (distinguishes e.g. `string` from `string | null`).
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

interface User {
  uuid: string;
  name: string;
}
interface Tag {
  uuid: string;
  label: string;
}

const props = {
  name: text(),
  age: integer(),
  score: float(),
  active: boolean(),
  born: date(),
  profile: json<{ bio: string }>(),
  owner: relationToOne<User>({ model: "User" }),
  tags: relationToMany<Tag>({ model: "Tag" })
};

type Model = InferModel<typeof props>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _assertions = [
  Assert<Equals<Model["name"], string>>,
  Assert<Equals<Model["age"], number>>,
  Assert<Equals<Model["score"], number>>,
  Assert<Equals<Model["active"], boolean>>,
  Assert<Equals<Model["born"], Date>>,
  Assert<Equals<Model["profile"], { bio: string }>>,
  Assert<Equals<Model["owner"], User | null>>,
  Assert<Equals<Model["tags"], Tag[]>>,
  Assert<Equals<Model["uuid"], string>>
];

export {};
