import { describe, it, expect } from "vitest";
import { RepositoryManager } from "./RepositoryManager.js";
import { InMemoryBackend } from "../backends/memory/InMemoryBackend.js";
import { text, relationToOne, relationToMany } from "../properties/factories.js";

interface UserModel {
  uuid: string;
  name: string;
  events: EventModel[];
}
interface EventModel {
  uuid: string;
  title: string;
  users: UserModel[];
}

// Mutual many-to-many: User.events <-> Event.users.
function manyToMany(orm: RepositoryManager) {
  const users = orm.define({
    name: "User",
    properties: {
      name: text(),
      events: relationToMany<EventModel>({ model: "Event", remoteProperty: "users" })
    }
  });
  const events = orm.define({
    name: "Event",
    properties: {
      title: text(),
      users: relationToMany<UserModel>({ model: "User", remoteProperty: "events" })
    }
  });
  return { users, events };
}

describe("relations — to-many (mutual)", () => {
  it("maintains the inverse side in memory when saving one side", async () => {
    const orm = new RepositoryManager();
    const { users, events } = manyToMany(orm);

    const e1 = events.createInstance({ title: "Birthday" });
    const e2 = events.createInstance({ title: "Interview" });
    const peter = users.createInstance({ name: "Peter", events: [e1, e2] });

    users.save(peter);
    await users.persist();

    expect(e1.users.map((u) => u.uuid)).toEqual([peter.uuid]);
    expect(e2.users.map((u) => u.uuid)).toEqual([peter.uuid]);
  });

  it("persists both directions and restores them on a cold read", async () => {
    const backend = new InMemoryBackend();

    // Writer manager.
    const orm1 = new RepositoryManager({ backend });
    const w = manyToMany(orm1);
    const e1 = w.events.createInstance({ title: "Birthday" });
    const e2 = w.events.createInstance({ title: "Interview" });
    const peter = w.users.createInstance({ name: "Peter", events: [e1, e2] });
    w.users.save(peter);
    await w.users.persist();

    // Fresh manager over the same backend → caches are cold, everything loads from storage.
    const orm2 = new RepositoryManager({ backend });
    const r = manyToMany(orm2);

    const loadedEvents = await r.events.all().list();
    expect(loadedEvents).toHaveLength(2);

    const birthday = loadedEvents.find((e) => e.uuid === e1.uuid)!;
    expect(birthday.title).toBe("Birthday");
    expect(birthday.users.map((u) => u.name)).toEqual(["Peter"]);

    // The cycle resolves: the loaded user's events point back at both events.
    const loadedPeter = birthday.users[0]!;
    expect(loadedPeter.events.map((e) => e.uuid).sort()).toEqual([e1.uuid, e2.uuid].sort());
    // And identity holds — the user reached two ways is the same object.
    const other = loadedEvents.find((e) => e.uuid === e2.uuid)!;
    expect(other.users[0]).toBe(loadedPeter);
  });
});

describe("relations — to-one", () => {
  interface ProfileModel {
    uuid: string;
    bio: string;
  }
  interface AccountModel {
    uuid: string;
    handle: string;
    profile: ProfileModel | null;
  }

  function withProfiles(orm: RepositoryManager) {
    const profiles = orm.define({ name: "Profile", properties: { bio: text() } });
    const accounts = orm.define({
      name: "Account",
      properties: {
        handle: text(),
        profile: relationToOne<ProfileModel>({ model: "Profile" })
      }
    });
    return { profiles, accounts };
  }

  it("stores a uuid and eager-loads the related record on a cold read", async () => {
    const backend = new InMemoryBackend();

    const orm1 = new RepositoryManager({ backend });
    const w = withProfiles(orm1);
    const profile = w.profiles.createInstance({ bio: "hello" });
    w.profiles.save(profile);
    const account = w.accounts.createInstance({ handle: "neo", profile });
    w.accounts.save(account);
    await w.accounts.persist();

    const orm2 = new RepositoryManager({ backend });
    const r = withProfiles(orm2);
    const [loaded] = await r.accounts.all().list();
    expect(loaded!.handle).toBe("neo");
    expect(loaded!.profile?.bio).toBe("hello");
  });

  it("stores null when the relation is unset", async () => {
    const orm = new RepositoryManager();
    const { accounts } = withProfiles(orm);
    const account = accounts.createInstance({ handle: "trinity" });
    expect(account.profile).toBeNull();
    accounts.save(account);
    await accounts.persist();
    const [loaded] = await accounts.all().list();
    expect(loaded!.profile).toBeNull();
  });
});

describe("relations — errors", () => {
  it("throws a clear error when a relation targets an undefined model", async () => {
    const orm = new RepositoryManager();
    const things = orm.define({
      name: "Thing",
      properties: { other: relationToOne({ model: "Missing" }) }
    });
    // Dangling reference to a model that was never defined.
    const thing = things.createInstance({ other: { uuid: "ghost" } as never });
    things.save(thing);
    await things.persist();

    await expect(things.all().list()).rejects.toThrow(/unknown model "Missing"/);
  });
});
