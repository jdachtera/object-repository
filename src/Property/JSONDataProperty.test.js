import { JSONDataProperty } from "./JSONDataProperty";

describe("JSONData property class", () => {
  it("should parse the JSON string to an object and back", async () => {
    const property = new JSONDataProperty();

    const instance = {};

    const sourceJson = JSON.stringify({
      deeply: { nested: { data: ["yes"] } }
    });

    await property.setInstanceProperty(instance, "customData", sourceJson);

    const value = await property.getInstanceProperty(instance, "customData");

    expect(instance.customData.deeply.nested.data[0]).toEqual("yes");
    expect(value).toEqual(sourceJson);
  });

  it("should call the preStringify and postParse hooks", async () => {
    const property = new JSONDataProperty({
      preStringify: async ({ additionalInfo, ...data }) => ({
        ...data,
        checksum: Object.keys(data).length
      }),
      postParse: async ({ checksum, ...data }) => ({
        ...data,
        additionalInfo: "test"
      })
    });

    const instance = {};

    const sourceJson = JSON.stringify({
      deeply: { nested: { data: ["yes"] } }
    });

    await property.setInstanceProperty(instance, "customData", sourceJson);

    const value = await property.getInstanceProperty(instance, "customData");

    expect(instance.customData.deeply.nested.data[0]).toEqual("yes");
    expect(instance.customData.additionalInfo).toEqual("test");
    expect(value).toEqual(
      '{"deeply":{"nested":{"data":["yes"]}},"checksum":1}'
    );

    await property.setInstanceProperty(
      instance,
      "customData",
      '{"deeply":{"nested":{"data":["yes"]}},"checksum":1}'
    );

    expect(instance.customData.checksum).toBeUndefined();
  });
});
