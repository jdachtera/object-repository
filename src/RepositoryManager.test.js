import { RepositoryManager } from "./RepositoryManager";
import prop from "./Property";
import expr from "./Expression";

describe("orm integration test", () => {
  it("should construct a repository and save a model instance", async () => {
    const orm = new RepositoryManager();

    const userRepository = orm.define({
      name: "User",
      properties: {
        firstName: prop.text(),
        lastName: prop.text(),
        age: prop.integer()
      }
    });

    const peter = userRepository.createInstance({
      firstName: "Peter",
      lastName: "Pan",
      age: 35
    });

    expect(peter.firstName).toEqual("Peter");
    expect(peter.lastName).toEqual("Pan");
    expect(peter.age).toEqual(35);

    userRepository.save(peter);
    await userRepository.persist();

    const uuid = peter.uuid;

    expect(uuid).toHaveLength(32);

    const john = userRepository.createInstance({
      firstName: "John",
      lastName: "Johnson",
      age: 40
    });

    userRepository.save(john);
    await userRepository.persist();

    const firstResults = await userRepository
      .all()
      .filter(expr.eq("firstName", "Peter"))
      .list();

    expect(firstResults).toEqual([peter]);

    const secondResults = await userRepository
      .all()
      .filter(expr.eq("firstName", "John"))
      .list();

    expect(secondResults).toEqual([john]);

    const thirdResults = await userRepository
      .all()
      .filter(
        expr.or(expr.eq("firstName", "John"), expr.eq("firstName", "Peter"))
      )
      .list();

    expect(thirdResults).toEqual([peter, john]);
  });

  it("should save and restore a many to many relation", async () => {
    const orm = new RepositoryManager();

    const userRepository = orm.define({
      name: "User",
      properties: {
        name: prop.text()
      }
    });

    const eventRepository = orm.define({
      name: "Event",
      properties: {
        title: prop.text(),
        users: prop.relationToMany({
          remoteProperty: "events",
          repository: userRepository
        })
      }
    });

    userRepository.addModelProperty(
      "events",
      prop.relationToMany({
        remoteProperty: "users",
        repository: eventRepository
      })
    );

    const peter = userRepository.createInstance({
      name: "peter",
      events: [
        eventRepository.createInstance({
          title: "Chris birthday"
        }),
        eventRepository.createInstance({
          title: "Job interview"
        })
      ]
    });

    userRepository.save(peter);
    await userRepository.persist();

    expect(peter.events.get(0).uuid).toHaveLength(32);
    expect(peter.events.get(1).uuid).toHaveLength(32);

    expect(peter.toJSON()).toEqual({
      events: [peter.events.get(0).uuid, peter.events.get(1).uuid],
      name: "peter",
      uuid: peter.uuid
    });

    const results = await eventRepository.all().list();

    expect(results).toHaveLength(2);
    expect(results[0].uuid).toHaveLength(32);

    expect(results[1].uuid).toHaveLength(32);
    expect(results[0].title).toEqual("Chris birthday");
    expect(results[0].uuid).toEqual(peter.events.get(0).uuid);
    expect(results[0].users.array).toHaveLength(1);
    expect(results[0].users.get(0).uuid).toEqual(peter.uuid);

    expect(results[1].title).toEqual("Job interview");
    expect(results[1].uuid).toEqual(peter.events.get(1).uuid);
    expect(results[1].users.array).toHaveLength(1);
    expect(results[0].users.get(0).uuid).toEqual(peter.uuid);
  });
});
