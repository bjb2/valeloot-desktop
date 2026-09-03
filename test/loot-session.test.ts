import { expect, test } from "bun:test";
import { artifactFacts, equipmentFacts } from "../src/core/catalog.ts";
import { LootSession } from "../src/core/loot-session.ts";
import type { SaviArtifact, SaviEquip, SaviGem, SaviSnapshot, SaviStack, SaviSubstat } from "../src/core/types.ts";

function equipment(uid: string, substats: Array<SaviSubstat | null> = []): SaviEquip {
  return {
    slot: -1,
    uid,
    itemId: "Abyss Shard",
    refine: 0,
    cards: [],
    substats,
    startingPotential: 0,
    spentPotential: 0,
    chaosType: -1,
    favorite: false,
  };
}

function gem(uid: string): SaviGem {
  return {
    uid,
    itemId: "AtkSpd Gem",
    refine: 2,
    favorite: false,
  };
}

function card(count: number): SaviStack {
  return { itemId: "Abomination", count, favorite: false };
}

function snapshot(items: SaviEquip[], partial = false, gems: SaviGem[] = [], cards: SaviStack[] = []): SaviSnapshot {
  return {
    schema: 1,
    updateType: 0,
    name: "",
    title: null,
    archetypes: [1],
    level: 1,
    exp: 0,
    jobLevel: 1,
    jobExp: 0,
    attributes: [0, 0, 0, 0, 0, 0],
    activeLoadout: 0,
    equips: [],
    loadouts: [[], [], []],
    artifacts: [],
    skills: [],
    assigned: [],
    grimoires: [],
    mapId: null,
    capturedAt: "",
    partial,
    inventory: {
      equips: items,
      artifacts: [],
      cards,
      gems,
      junks: [],
      consumables: [],
    },
  };
}

test("decoded inventory remains authoritative when the later character tail is partial", () => {
  const session = new LootSession();
  session.consume(snapshot([equipment("a")]));
  expect(session.consume(snapshot([equipment("a"), equipment("b")])).added.map((item) => item.uid)).toEqual(["b"]);
  session.consume(snapshot([equipment("b")]));
  expect(session.consume(snapshot([equipment("b"), equipment("a")])).added.map((item) => item.uid)).toEqual(["a"]);
  session.consume(snapshot([equipment("a")], true));
  expect(session.bag().map((item) => item.uid)).toEqual(["a"]);
});

test("gems enter the bag and match Gem rules", () => {
  const session = new LootSession();
  session.setFilter('Show "gems"\n  Type Gem\n  Tag GEM');
  session.consume(snapshot([]));
  const result = session.consume(snapshot([], false, [gem("gem-1")]));

  expect(result.added).toHaveLength(1);
  expect(result.added[0]).toMatchObject({
    uid: "gem-1",
    itemId: "AtkSpd Gem",
    name: "Tempo Gem",
    type: "Gem",
    kind: "gem",
    refine: 2,
    match: { tag: "GEM" },
  });
  expect(session.bag()).toHaveLength(1);
});

test("cards enter the bag and repeated stack increases trigger additions", () => {
  const session = new LootSession();
  session.setFilter('Show "cards"\n  Type Card\n  Tag CARD');
  session.consume(snapshot([]));

  const first = session.consume(snapshot([], false, [], [card(1)]));
  expect(first.added).toHaveLength(1);
  expect(first.added[0]).toMatchObject({
    uid: "Abomination:card",
    itemId: "Abomination",
    name: "Abomination Card",
    type: "Card",
    kind: "card",
    count: 1,
    match: { tag: "CARD" },
  });

  expect(session.consume(snapshot([], false, [], [card(2)])).added).toHaveLength(1);
  expect(session.consume(snapshot([], false, [], [card(2)])).added).toHaveLength(0);
  expect(session.bag()[0]?.count).toBe(2);
});

test("catalog facts use displayed values and preserve chaos slot holes", () => {
  const item = equipment("facts", [
    { index: 0, type: 2, roll: 50, valueStr: null },
    null,
    { index: 2, type: 999, roll: 100, valueStr: null },
  ]);
  item.chaosType = 2;
  const facts = equipmentFacts(item);
  expect(facts.lines[0]?.base).toBe(3);
  expect(facts.lines[0]?.rollPct).toBe(50);
  expect(facts.lines[0]?.isChaos).toBe(false);
  expect(facts.lines[1]?.isChaos).toBe(true);
  expect(facts.avgRollPct).toBe(75);
  expect(facts.topRolls).toBeNull();
});

test("catalog facts apply chest-specific substat caps", () => {
  const item = equipment("chest", [{ index: 0, type: 71, roll: 100, valueStr: null }]);
  item.itemId = "ArcaneChest";
  const facts = equipmentFacts(item);
  expect(facts.slotType).toBe("Chest");
  expect(facts.lines[0]?.base).toBe(10);
  expect(facts.lines[0]?.rollPct).toBe(100);
  expect(facts.topRolls).toBe(1);
  expect(facts.view.icon).toBe("equip-V2_Chest_17.webp");
});

test("artifact facts resolve the concrete slot piece", () => {
  const item: SaviArtifact = {
    slot: 1,
    uid: "artifact",
    itemId: "Auto",
    refine: 0,
    gems: [],
    substats: [],
    favorite: false,
  };
  const facts = artifactFacts(item);
  expect(facts.view.name).toBe("Blitzcore Jewel");
  expect(facts.view.type).toBe("Jewel");
  expect(facts.view.icon).toBe("artifact-auto-1.webp");
});

test("changing the filter threshold recalculates current high-roll counts", () => {
  const session = new LootSession();
  session.setFilter("Threshold 90");
  session.consume(snapshot([equipment("a", [{ index: 0, type: 2, roll: 92, valueStr: null }])]));
  expect(session.bag()[0]?.highRolls).toBe(1);
  session.setFilter("Threshold 95");
  expect(session.bag()[0]?.highRolls).toBe(0);
});

test("high-roll metrics do not imply an active filter rule", () => {
  const session = new LootSession();
  session.consume(snapshot([equipment("high", [{ index: 0, type: 2, roll: 100, valueStr: null }])]));
  expect(session.filter.rules).toEqual([]);
  expect(session.bag()[0]?.highRolls).toBe(1);
  expect(session.bag()[0]?.match).toBeNull();
});

test("hidden matches never project, play, or enter history", () => {
  const played: string[] = [];
  const session = new LootSession({ soundsEnabled: () => true, onSound: (sound) => { played.push(sound); return true; } });
  session.setFilter('AlwaysHide "Abyss Shard"');
  session.consume(snapshot([]));
  const result = session.consume(snapshot([equipment("hidden")]));
  expect(result.added[0]?.match).toBeNull();
  expect(session.bag()[0]?.match).toBeNull();
  expect(session.history()).toEqual([]);
  expect(played).toEqual([]);
});

test("one snapshot awards sound priority once and records every visible match", () => {
  const played: string[] = [];
  const session = new LootSession({ soundsEnabled: () => true, onSound: (sound) => { played.push(sound); return true; } });
  session.setFilter('Show "shards"\n  Name "Abyss Shard"\n  Sound chime');
  session.consume(snapshot([]));
  session.consume(snapshot([equipment("first"), equipment("second")]));
  expect(played).toEqual(["chime"]);
  expect(session.history()).toHaveLength(2);
  expect(session.history().filter((entry) => entry.soundWinner)).toHaveLength(1);
  expect(session.history().filter((entry) => entry.soundPlayed)).toHaveLength(1);
  session.clearHistory();
  expect(session.history()).toEqual([]);
});

test("async sound dispatch updates history only after confirmation", async () => {
  let confirm!: (played: boolean) => void;
  const session = new LootSession({
    soundsEnabled: () => true,
    onSound: () => new Promise<boolean>((resolve) => { confirm = resolve; }),
  });
  session.setFilter('Show "shards"\n  Name "Abyss Shard"\n  Sound chime');
  session.consume(snapshot([]));
  session.consume(snapshot([equipment("confirmed")]));
  expect(session.history()[0]?.soundPlayed).toBe(false);
  confirm(true);
  await Promise.resolve();
  expect(session.history()[0]?.soundPlayed).toBe(true);
  expect(session.history()[0]?.note).toBe("alert played");

  const rejected = new LootSession({
    soundsEnabled: () => true,
    onSound: () => Promise.reject(new Error("transport failed")),
  });
  rejected.setFilter('Show "shards"\n  Name "Abyss Shard"\n  Sound chime');
  rejected.consume(snapshot([]));
  rejected.consume(snapshot([equipment("rejected")]));
  await Promise.resolve();
  expect(rejected.history()[0]?.soundPlayed).toBe(false);
  expect(rejected.history()[0]?.note).toBe("sound unavailable or disabled");
});
