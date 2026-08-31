import { expect, test } from "bun:test";
import { parseLootFilter } from "../src/core/filter/loot-dsl.ts";
import { matchLoot } from "../src/core/filter/loot-filter.ts";
test("canonical parser preserves exclusive stat semantics", () => { const parsed = parseLootFilter('Show "strict"\n  Stat Str > 3'); expect(parsed.errors).toEqual([]); const item = { uid: "x", itemId: "x", name: "x", slotType: "Dagger", refine: 0, lines: [{ stat: "Str", base: 3, rollPct: 100, isChaos: false, over: false }], topRolls: 0, highRolls: 1, avgRollPct: 100, favorite: false, hasChaos: false }; expect(matchLoot(item, parsed.rules, { threshold: 90 })).toBeNull(); });
test("bad filter lines reject their rule", () => { expect(parseLootFilter("Show x\n  Protect y").errors).not.toEqual([]); });
test("shipped starter ruleset is a valid 28-rule filter", async () => {
  const text = await Bun.file(new URL("../docs/starter-ruleset.txt", import.meta.url)).text();
  const parsed = parseLootFilter(text);
  expect(parsed.errors).toEqual([]);
  expect(parsed.rules).toHaveLength(28);
  expect(parsed.threshold).toBe(90);
});

test("visual equipment smoke rules parse with distinct treatments and sounds", () => {
  const parsed = parseLootFilter(`Show "Accessories — holo glow"
  Type Accessory, Back, Eyewear
  Color #ff3bd4
  Tag HOLO
  Highlight glow
  Background holo
  Border on
  Sound alert

Show "Armor — fill mark"
  Type Chest, Feet, Head, Legs, Shield
  Color #35e87a
  Tag ARMOR
  Highlight mark
  Background fill
  Border on
  Sound chime

Show "Ranged — border glow"
  Type Bow, GatlingGun, Launcher, Pistol, Rifle, Shotgun
  Color #38bdf8
  Tag RANGE
  Highlight glow
  Background border
  Border on
  Sound ding

Show "Magic — holo mark"
  Type Book, Grimoire, Wand
  Color #a78bfa
  Tag MAGIC
  Highlight mark
  Background holo
  Border on
  Sound alert

Show "Melee — fill dot"
  Type Axe, Dagger, Katar, Mace, Scythe, Spear, Sword, Twinblade
  Color #ffb020
  Tag MELEE
  Highlight dot
  Background fill
  Border on
  Sound thud`);
  expect(parsed.errors).toEqual([]);
  expect(parsed.rules).toHaveLength(5);
  expect(parsed.rules.map((rule) => [rule.highlight, rule.background, rule.sound])).toEqual([
    ["glow", "holo", "alert"],
    ["mark", "fill", "chime"],
    ["glow", "border", "ding"],
    ["mark", "holo", "alert"],
    ["dot", "fill", "thud"],
  ]);
});
