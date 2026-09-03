import { expect, test } from "bun:test";
import { decodeCharacterData, decodePersonalStorageBatchPayload } from "../src/core/character-data.ts";
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
    .dict([], () => undefined).dict([], () => undefined)
    .dict([["gem-uid", "AtkSpd Gem"]] as const, (itemId) => {
      writer.objectRef(true)
        .string("gem-uid").packed(2).string(itemId).bool(false);
    })
    .dict([], () => undefined).dict([], () => undefined).dict([], () => undefined)
    .packed(0).packed(3600).packed(25).packed(3).packed(2);

  const snapshot = decodeCharacterData(writer.bytes());
  expect(snapshot.name).toBe("Current Hero");
  expect(snapshot.attributes).toEqual([60, 30, 10, 20, 5, 15]);
  expect(snapshot.mapId).toBe("Nevaris");
  expect(snapshot.partial).toBe(false);
  expect(snapshot.inventory?.equips.map((item) => item.itemId)).toEqual(["ArcaneChest"]);
  expect(snapshot.inventory?.gems).toEqual([{
    uid: "gem-uid",
    itemId: "AtkSpd Gem",
    refine: 2,
    favorite: false,
  }]);
});

test("personal storage completion exposes the authoritative character inventory", () => {
  const writer = new Writer();
  writer.string("storage-request").packed(300).packed(600).string(null);
  writeCardInventory(writer, 2);
  writer.packed(17);
  writeCardInventory(writer, 5);

  expect(decodePersonalStorageBatchPayload(writer.bytes())?.cards).toEqual([{
    itemId: "Abomination",
    count: 2,
    favorite: false,
  }]);
});

function writeCardInventory(writer: Writer, count: number): void {
  writer.objectRef(true)
    .dict([], () => undefined)
    .dict([], () => undefined)
    .dict([["Abomination", count]] as const, (value) => {
      writer.objectRef(true).packed(value).string("Abomination").bool(false);
    })
    .dict([], () => undefined)
    .dict([], () => undefined)
    .dict([], () => undefined)
    .dict([], () => undefined);
}
