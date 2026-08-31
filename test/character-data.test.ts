import { expect, test } from "bun:test";
import { decodeCharacterData } from "../src/core/character-data.ts";
import { Writer } from "../src/core/wire.ts";

test("current CharacterState return fields keep inventory aligned", () => {
  const writer = new Writer();
  writer.objectRef(true)
    .string("character-id").string("account-id").packed(1)
    .string("").string("").string("Current Hero")
    .objectRef(true);
  for (let index = 0; index < 10; index++) writer.packed(index);
  writer.objectRef(true).list([], () => undefined)
    .list([], () => undefined)
    .string(null).string(null).string(null)
    .list([6], (value) => writer.packed(value))
    .packed(127).packed(0).packed(70).packed(0)
    .objectRef(true).float(1).float(1).string("Nevaris")
    .objectRef(false)
    .string("ReturnMap")
    .objectRef(true).float(10).float(20).float(30)
    .list([], () => undefined).packed(0)
    .list([], () => undefined).list([], () => undefined)
    .list([60, 30, 10, 20, 5, 15], (value) => writer.packed(value))
    .list([], () => undefined).packed(0)
    .list([], () => undefined).list([], () => undefined).list([], () => undefined)
    .list([], () => undefined)
    .objectRef(false)
    .list([], () => undefined)
    .objectRef(true)
    .dict([["bag-uid", "ArcaneChest"]] as const, (itemId) => {
      writer.objectRef(true)
        .list([], () => undefined).list([], () => undefined)
        .packed(0).packed(0).packed(-1)
        .string("bag-uid").packed(0).string(itemId).bool(false);
    })
    .dict([], () => undefined).dict([], () => undefined).dict([], () => undefined)
    .dict([], () => undefined).dict([], () => undefined).dict([], () => undefined)
    .packed(0).packed(3600).packed(25).packed(3).packed(2);

  const snapshot = decodeCharacterData(writer.bytes());
  expect(snapshot.name).toBe("Current Hero");
  expect(snapshot.attributes).toEqual([60, 30, 10, 20, 5, 15]);
  expect(snapshot.mapId).toBe("Nevaris");
  expect(snapshot.partial).toBe(false);
  expect(snapshot.inventory?.equips.map((item) => item.itemId)).toEqual(["ArcaneChest"]);
});
