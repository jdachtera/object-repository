import { DateProperty } from "./DateProperty";

describe("Date property class", () => {
  it("should set the date to unix beginnning of time", async () => {
    const date = new DateProperty();
    const value = await date.getInstanceProperty({}, "createdAt");

    expect(value).toEqual(0);
  });

  it("should set the date to the current time", async () => {
    const date = new DateProperty({ autoUpdate: true });

    const now = Date.now();
    const value = await date.getInstanceProperty({}, "createdAt");

    expect(value).toEqual(now);
  });

  it("should convert the date to integer", async () => {
    const date = new DateProperty();
    const createdAt = new Date();
    createdAt.setTime(Date.now());

    const value = await date.getInstanceProperty(
      {
        createdAt
      },
      "createdAt"
    );

    expect(value).toEqual(createdAt.getTime());
  });

  it("should convert the integer string to a date", async () => {
    const date = new DateProperty();

    const instance = {};

    await date.setInstanceProperty(instance, "createdAt", "12345");

    expect(instance.createdAt.getTime()).toEqual(12345);
  });
});
