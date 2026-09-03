/** Decoded shapes. Field names follow the game's own DTO names (see docs/character-data-layout.md). */

/** One substat line. `roll` is the raw 0..100 the server sent (`StatData.Value`), NOT a scaled value. */
export interface SaviSubstat {
  /** Position in the item's substat array. The chaos slot is the LAST index (equipment only). */
  index: number;
  /** Game `StatType` enum value. */
  type: number;
  /** `StatData.Value` — for substats this is the 0..100 roll. */
  roll: number;
  /** `StatData.ValueStr` — the qualifier (a skill/element id) when the stat needs one. */
  valueStr: string | null;
}

export interface SaviGem {
  uid: string | null;
  itemId: string;
  refine: number;
  favorite: boolean;
}

export interface SaviEquip {
  /** Game `EquipSlot` value; -1 for inventory/grimoire items that carry no slot. */
  slot: number;
  uid: string | null;
  itemId: string;
  refine: number;
  /** Socketed card ids, holes preserved. */
  cards: Array<string | null>;
  /** Substat array with holes preserved — index is meaningful (chaos = last). */
  substats: Array<SaviSubstat | null>;
  startingPotential: number;
  spentPotential: number;
  /** Game `EquipType` of the chaos substat, or -1/None. */
  chaosType: number;
  favorite: boolean;
}

export interface SaviArtifact {
  /** Game `ArtifactSlot`: 0 Rune, 1 Jewel, 2 Scroll, 3 Relic. */
  slot: number;
  uid: string | null;
  itemId: string;
  refine: number;
  gems: SaviGem[];
  substats: Array<SaviSubstat | null>;
  favorite: boolean;
}

export interface SaviStack {
  itemId: string;
  count: number;
  favorite: boolean;
}

export interface SaviInventory {
  equips: SaviEquip[];
  artifacts: SaviArtifact[];
  cards: SaviStack[];
  gems: SaviGem[];
  junks: SaviStack[];
  consumables: SaviStack[];
}

export interface SaviSkill {
  id: string;
  level: number;
}

/** Everything the character payload gives us, with nothing dropped. */
export interface SaviSnapshot {
  schema: 1;
  /** `CharacterCallback_T` update mask; `LoadCharacter_T` payloads report FULL. */
  updateType: number;
  name: string;
  title: string | null;
  /** Game `Archetype` values, base first. */
  archetypes: number[];
  level: number;
  exp: number;
  jobLevel: number;
  jobExp: number;
  /** STR, VIT, AGI, DEX, INT, LUK — raw ints as sent. */
  attributes: number[];
  /** Game `WeaponLoadout`: 0 Normal, 1 Secondary, 2 Heavy. */
  activeLoadout: number;
  /** `CharacterData.Equips` — what is worn right now. */
  equips: SaviEquip[];
  /** The three stored loadouts, in `WeaponLoadout` order. */
  loadouts: [SaviEquip[], SaviEquip[], SaviEquip[]];
  artifacts: SaviArtifact[];
  skills: SaviSkill[];
  assigned: SaviSkill[];
  grimoires: SaviEquip[];
  /** Present only when the payload carried the inventory block. */
  inventory?: SaviInventory;
  /** `CharacterStateData.MapId` — the map the character is standing on. */
  mapId: string | null;
  playtimeSeconds?: number;
  monsterKills?: number;
  bossKills?: number;
  deaths?: number;
  /** When WE decoded it (the payload carries no wall clock). */
  capturedAt: string;
  /** True when the payload ended before the history block (a partial update). */
  partial: boolean;
  /**
   * Why the decode stopped. Fields assigned before that offset remain complete; notably, inventory
   * is assigned only after the full bag has decoded.
   */
  partialReason?: string;
}

export const EQUIP_SLOT_NAMES: Record<number, string> = {
  0: 'Mainhand', 1: 'Offhand', 2: 'Head', 3: 'Legs', 4: 'Feet',
  5: 'Chest', 6: 'AccessoryLeft', 7: 'AccessoryRight', 8: 'Eyewear', 9: 'Back',
};

export const ARTIFACT_SLOT_NAMES: Record<number, string> = { 0: 'Rune', 1: 'Jewel', 2: 'Scroll', 3: 'Relic' };

export const LOADOUT_NAMES = ['Normal', 'Secondary', 'Heavy'] as const;

/** Game `Archetype` enum (dump.cs). 100+ are the NPC vendor archetypes, never a player class. */
export const ARCHETYPE_NAMES: Record<number, string> = {
  [-1]: 'Novice', 0: 'Warrior', 1: 'Mage', 2: 'Rogue', 3: 'Knight', 4: 'Summoner', 5: 'Acolyte', 6: 'Scout',
  10: 'Paladin', 11: 'DragonKnight', 12: 'Berserker', 13: 'Revenant', 14: 'Priest', 15: 'Monk', 16: 'Wizard',
  17: 'Chronomancer', 18: 'Druid', 19: 'Warlock', 20: 'Assassin', 21: 'Shinobi', 22: 'Gunslinger', 23: 'Ranger',
  24: 'Jester', 25: 'Nightshade', 26: 'Necromancer', 27: 'Spellblade', 28: 'BladeMaster', 29: 'Mechanist',
  30: 'Alchemist', 31: 'Weaver',
  100: 'Merchant', 101: 'Blacksmith', 102: 'Cardweaver', 103: 'Craftsman', 104: 'Stylist', 105: 'Gemsmith', 106: 'Artificer',
};
