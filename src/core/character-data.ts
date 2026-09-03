/**
 * `CharacterData` decoder.
 *
 * Field order is the class's declaration order from the game's IL2CPP dump, and inheritance
 * serialises MOST-DERIVED FIRST (so `EquipData`'s own five fields precede `RefinableItemData`'s
 * UID/Refine, which precede `InventoryItemData`'s Id/Favorite). The full provenance table —
 * every class, every field, where it came from — is docs/character-data-layout.md.
 *
 * Two things this decoder deliberately does that a stat overlay does not need, because
 * spiritvalers.com needs them:
 *   1. Substat arrays keep their HOLES. Position is meaning: the chaos slot is the last index of an
 *      equipment substat array, and a dense list cannot tell you which line it was. Flattening the
 *      nulls away would make us silently present a chaos roll as a normal substat.
 *   2. Grimoires and the whole inventory are captured, not skipped. They are on the wire already.
 *
 * The payload may legitimately END EARLY (a partial `CharacterCallback_T`). Everything from the
 * skill block onward is therefore read inside a boundary that preserves fields decoded before the
 * failure. In particular, `inventory` is assigned only after the complete bag has been decoded.
 */

import { Reader } from './wire.ts';
import type {
  SaviArtifact, SaviEquip, SaviGem, SaviInventory, SaviSkill, SaviSnapshot, SaviStack, SaviSubstat,
} from './types.ts';

/** `CharacterCallback_T` update mask meaning "the whole character" (all bits the client sets). */
export const UPDATE_FULL = 327417855;

const UID_MAX = 80;
const ID_MAX = 256;

export interface DecodeOptions {
  /** `CharacterCallback_T` prefixes the payload with the update mask; `LoadCharacter_T` does not. */
  includesUpdateType?: boolean;
  /** Injected for deterministic tests. */
  now?: Date;
}

export function decodeCharacterData(payload: Uint8Array, options: DecodeOptions = {}): SaviSnapshot {
  const r = new Reader(payload);
  const updateType = options.includesUpdateType ? r.packed() : UPDATE_FULL;
  if (!r.objectRef()) throw new Error('CharacterData payload carries a null character');

  r.string(UID_MAX);            // UID            — identifying, deliberately discarded
  r.string(UID_MAX);            // AccountId      — identifying, deliberately discarded
  r.packed();                   // Version
  r.string(UID_MAX);            // GuildId
  r.string(UID_MAX);            // GuildRankId
  const name = r.string(64) ?? '';
  skipAppearance(r);            // Appearance
  skipEquipAppearance(r);       // EquipAppearance
  skipCosmeticSlots(r);         // Cosmetics
  const title = r.string(ID_MAX);
  r.string(ID_MAX);             // ChatBubble
  r.string(ID_MAX);             // Badge
  const archetypes = r.list(() => r.packed());
  const level = r.packed();
  const exp = r.packed();
  const jobLevel = r.packed();
  const jobExp = r.packed();
  const mapId = readState(r);
  const attributes = r.list(() => r.packed());
  if (attributes.length < 6) throw new Error(`CharacterData carried ${attributes.length} attributes, expected >= 6`);
  for (const value of attributes) {
    if (!Number.isInteger(value) || value < 0 || value > 100_000) throw new Error(`implausible attribute value ${value}`);
  }
  const equips = readEquipSlotList(r);
  const activeLoadout = r.packed();
  const loadouts: [SaviEquip[], SaviEquip[], SaviEquip[]] = [readEquipSlotList(r), readEquipSlotList(r), readEquipSlotList(r)];
  const artifacts = r.list(() => readArtifact(r)).filter(isPresent);

  const snapshot: SaviSnapshot = {
    schema: 1,
    updateType,
    name,
    title: title || null,
    archetypes,
    level, exp, jobLevel, jobExp,
    attributes,
    activeLoadout,
    equips,
    loadouts,
    artifacts,
    skills: [],
    assigned: [],
    grimoires: [],
    mapId,
    capturedAt: (options.now ?? new Date()).toISOString(),
    partial: false,
  };

  // ---- tail: skills, grimoires, inventory, history. A partial update simply stops here. ----
  try {
    const skillSystem = readSkillSystem(r);
    snapshot.skills = skillSystem.skills;
    snapshot.assigned = skillSystem.assigned;
    snapshot.grimoires = r.list(() => readEquip(r, -1)).filter(isPresent);
    const inventory = readInventory(r);
    if (inventory) snapshot.inventory = inventory;
    r.packed();                              // LastLogin
    snapshot.playtimeSeconds = r.packed();   // Playtime
    snapshot.monsterKills = r.packed();
    snapshot.bossKills = r.packed();
    snapshot.deaths = r.packed();
  } catch (error) {
    snapshot.partial = true;
    /**
     * WHY it stopped, and how far it got. A snapshot can be partial after inventory was completely
     * decoded because the history counters follow it on the wire. In that case the decoded inventory
     * remains authoritative; if inventory itself fails, it is never assigned.
     */
    snapshot.partialReason = `${(error as Error).message} @${r.offset}/${payload.length}`;
  }
  return snapshot;
}

/** Smallest payload worth testing as a character. A real one runs tens of KB (the bag is in it). */
export const MIN_CHARACTER_BYTES = 2048;

/**
 * Identify a character payload WITHOUT trusting its RPC name.
 *
 * This exists because of a hard-won fact: FishNet registers RPC-link ids PER CONNECTION, so a capture
 * that starts mid-session cannot name linked RPCs at all — the character payload arrives as an
 * anonymous blob. On a live level-121 character, thousands of packets were unnameable and the
 * character was found purely by shape.
 *
 * The decoder is strict enough to be that test: it validates object-null flags, every string length
 * against the game's caps, collection bounds, and the attribute block. A payload decoded with the
 * WRONG update-mask assumption fails within a few fields (observed: `string length -28 outside
 * 0..80`), so trying both and demanding a plausible result is identification, not guesswork.
 */
export function identifyCharacterPayload(payload: Uint8Array, options: { now?: Date } = {}): SaviSnapshot | null {
  if (payload.length < MIN_CHARACTER_BYTES) return null;
  // CharacterCallback_T carries the mask, LoadCharacter_T does not; try the common one first.
  for (const includesUpdateType of [true, false]) {
    try {
      const snapshot = decodeCharacterData(payload, { includesUpdateType, ...(options.now ? { now: options.now } : {}) });
      if (isPlausibleCharacter(snapshot)) return snapshot;
    } catch { /* wrong assumption, or not a character at all */ }
  }
  return null;
}

/** Cheap sanity gate on a decoded snapshot: a real character, or a coincidence that happened to parse? */
function isPlausibleCharacter(snapshot: SaviSnapshot): boolean {
  if (!snapshot.name.trim()) return false;
  if (!Number.isInteger(snapshot.level) || snapshot.level < 1 || snapshot.level > 200) return false;
  if (snapshot.attributes.length < 6) return false;
  if (!snapshot.archetypes.length) return false;
  // Something has to be on the character: worn gear, artifacts, or a stored weapon set.
  return snapshot.equips.length > 0 || snapshot.artifacts.length > 0 || snapshot.loadouts.some((loadout) => loadout.length > 0);
}

/**
 * Decode a standalone `InventoryData` payload — the BANK.
 *
 * `PlayerCallback_Storage(storage: InventoryData)` (wireHash 62) carries account storage in exactly
 * the same shape as the character's own bag, so the reader is shared verbatim. The RPC has a single
 * parameter, which gives a strong validator the character payload does not have: after a good decode
 * the buffer must be FULLY consumed. That, plus the reader's own bounds checks, is what makes shape
 * identification trustworthy for link-invoked packets we cannot name.
 */
export function decodeInventoryPayload(payload: Uint8Array): SaviInventory | null {
  const r = new Reader(payload);
  const inventory = readInventory(r);
  if (!inventory) return null;
  if (r.remaining !== 0) return null;   // a real storage payload ends exactly here
  return inventory;
}

/** As above, but also demands the result look like real storage rather than an empty coincidence. */
export function identifyInventoryPayload(payload: Uint8Array): SaviInventory | null {
  if (payload.length < 64) return null;
  try {
    const inventory = decodeInventoryPayload(payload);
    if (!inventory) return null;
    const total = inventory.equips.length + inventory.artifacts.length + inventory.cards.length
      + inventory.gems.length + inventory.junks.length + inventory.consumables.length;
    return total > 0 ? inventory : null;
  } catch {
    return null;
  }
}

/**
 * Current personal-storage completion callback:
 * request id, two non-negative capacity values, status text, authoritative character inventory,
 * character version, then authoritative storage inventory. The bundled RPC map still labels wire
 * hash 62 with its older `PlayerCallback_Storage` name, so validation must follow the wire shape.
 */
export function decodePersonalStorageBatchPayload(payload: Uint8Array): SaviInventory | null {
  if (payload.length < 64) return null;
  try {
    const r = new Reader(payload);
    const requestId = r.string(ID_MAX);
    const bagCapacity = r.packed();
    const storageCapacity = r.packed();
    r.string(4096);
    const inventory = readInventory(r);
    const version = r.packed();
    const storage = readInventory(r);
    if (!requestId || bagCapacity < 0 || storageCapacity < 0 || version < 0 || !inventory || !storage || r.remaining !== 0) {
      return null;
    }
    const totalItems = (value: SaviInventory): number => value.equips.length + value.artifacts.length
      + value.cards.length + value.gems.length + value.junks.length + value.consumables.length;
    return totalItems(inventory) + totalItems(storage) > 0 ? inventory : null;
  } catch {
    return null;
  }
}

function isPresent<T>(value: T | undefined): value is T { return value !== undefined; }

// ---------------------------------------------------------------- skipped blocks ----

/** CharacterAppearanceData — 10 ints. */
function skipAppearance(r: Reader): void {
  if (!r.objectRef()) return;
  for (let i = 0; i < 10; i++) r.packed();
}

/** EquipAppearanceData — bool[] EquipSlotsHidden. */
function skipEquipAppearance(r: Reader): void {
  if (!r.objectRef()) return;
  r.list(() => r.bool());
}

/** List<CosmeticSlotData> { Slot, Id, Rarity, Shiny }. */
function skipCosmeticSlots(r: Reader): void {
  r.list(() => {
    if (!r.objectRef()) return;
    r.packed(); r.string(ID_MAX); r.packed(); r.bool();
  });
}

/**
 * CharacterStateData { HealthNormlised, ManaNormlised, MapId, Position, Summons, CloneCount,
 * Toggles, Effects }. Only MapId is kept — it is what powers "open this map on the wiki".
 */
function readState(r: Reader): string | null {
  if (!r.objectRef()) return null;
  r.float();                                   // HealthNormlised
  r.float();                                   // ManaNormlised
  const mapId = r.string(ID_MAX);
  if (r.objectRef()) { r.float(); r.float(); r.float(); }   // Position (VectorData)
  r.string(ID_MAX);                            // InstancedMapReturnMapId
  if (r.objectRef()) { r.float(); r.float(); r.float(); }   // InstancedMapReturnPosition
  r.list(() => { if (!r.objectRef()) return; r.string(ID_MAX); r.string(ID_MAX); r.packed(); r.bool(); r.bool(); }); // Summons
  r.packed();                                  // CloneCount
  r.list(() => { if (!r.objectRef()) return; r.string(ID_MAX); r.packed(); });                  // Toggles
  r.list(() => { if (!r.objectRef()) return; r.string(ID_MAX); r.packed(); r.float(); r.packed(); }); // Effects
  return mapId;
}

// ---------------------------------------------------------------- items ----

/** StatData { Type, Value, ValueStr } — `Value` is the 0..100 roll for a substat. */
function readSubstat(r: Reader, index: number): SaviSubstat | null {
  if (!r.objectRef()) return null;
  const type = r.packed();
  const roll = r.packed();
  const valueStr = r.string(ID_MAX);
  return { index, type, roll, valueStr };
}

/** List<EquipSlotData> { Slot, Equip }. */
function readEquipSlotList(r: Reader): SaviEquip[] {
  return r.list(() => {
    if (!r.objectRef()) return undefined;
    const slot = r.packed();
    return readEquip(r, slot);
  }).filter(isPresent);
}

/**
 * EquipData { Substats, Cards, StartingPotential, SpentPotential, ChaosType }
 *   : RefinableItemData { UID, Refine } : InventoryItemData { Id, Favorite }
 */
function readEquip(r: Reader, slot: number): SaviEquip | undefined {
  if (!r.objectRef()) return undefined;
  const substats = r.list((index) => readSubstat(r, index));
  const cards = r.list(() => r.string(ID_MAX));
  const startingPotential = r.packed();
  const spentPotential = r.packed();
  const chaosType = r.packed();
  const uid = r.string(UID_MAX);
  const refine = r.packed();
  const itemId = r.string(ID_MAX);
  const favorite = r.bool();
  if (!itemId) return undefined;
  return { slot, uid, itemId, refine, cards, substats, startingPotential, spentPotential, chaosType, favorite };
}

/**
 * ArtifactData { Substats, Slot, Gems }
 *   : RefinableItemData { UID, Refine } : InventoryItemData { Id, Favorite }
 */
function readArtifact(r: Reader): SaviArtifact | undefined {
  if (!r.objectRef()) return undefined;
  const substats = r.list((index) => readSubstat(r, index));
  const slot = r.packed();
  const gems = r.list(() => readGem(r)).filter(isPresent);
  const uid = r.string(UID_MAX);
  const refine = r.packed();
  const itemId = r.string(ID_MAX);
  const favorite = r.bool();
  if (!itemId) return undefined;
  return { slot, uid, itemId, refine, gems, substats, favorite };
}

/** GemData : RefinableItemData { UID, Refine } : InventoryItemData { Id, Favorite }. */
function readGem(r: Reader): SaviGem | undefined {
  if (!r.objectRef()) return undefined;
  const uid = r.string(UID_MAX);
  const refine = r.packed();
  const itemId = r.string(ID_MAX);
  const favorite = r.bool();
  return itemId ? { uid, itemId, refine, favorite } : undefined;
}

/** StackableItemData { Count } : InventoryItemData { Id, Favorite } (cards, junks, consumables). */
function readStack(r: Reader): SaviStack | undefined {
  if (!r.objectRef()) return undefined;
  const count = r.packed();
  const itemId = r.string(ID_MAX);
  const favorite = r.bool();
  return itemId ? { itemId, count: Math.max(0, count), favorite } : undefined;
}

/** CosmeticData { Rarity, Shiny } : RefinableItemData : InventoryItemData. */
function skipCosmetic(r: Reader): void {
  if (!r.objectRef()) return;
  r.packed(); r.bool(); r.string(UID_MAX); r.packed(); r.string(ID_MAX); r.bool();
}

/** SkillSystemData { Skills, Assigned, SkillCopy, Reanimations }. */
function readSkillSystem(r: Reader): { skills: SaviSkill[]; assigned: SaviSkill[] } {
  if (!r.objectRef()) return { skills: [], assigned: [] };
  const skills = r.list(() => readSkill(r)).filter(isPresent);
  const assigned = r.list(() => readSkill(r)).filter(isPresent);
  const copy = readSkill(r);                    // SkillCopy (Weaver)
  if (copy) skills.push(copy);
  r.list(() => r.string(ID_MAX));               // Reanimations
  // Keep the highest level per id: SkillCopy can restate a learned skill.
  const best = new Map<string, SaviSkill>();
  for (const skill of skills) {
    const previous = best.get(skill.id);
    if (!previous || skill.level > previous.level) best.set(skill.id, skill);
  }
  return { skills: [...best.values()], assigned };
}

/** SkillData { Id, Level }. */
function readSkill(r: Reader): SaviSkill | undefined {
  if (!r.objectRef()) return undefined;
  const id = r.string(ID_MAX);
  const level = r.packed();
  return id && level >= 0 ? { id, level } : undefined;
}

/**
 * InventoryData { Equips, Artifacts, Cards, Gems, Junks, Consumables, Cosmetics } — seven
 * Dictionary<string, T> in that exact order. Keys are item UIDs and carry no information the
 * values do not, so they are read and dropped.
 */
function readInventory(r: Reader): SaviInventory | undefined {
  if (!r.objectRef()) return undefined;
  const equips = r.dict(() => readEquip(r, -1)).filter(isPresent);
  const artifacts = r.dict(() => readArtifact(r)).filter(isPresent);
  const cards = r.dict(() => readStack(r)).filter(isPresent);
  const gems = r.dict(() => readGem(r)).filter(isPresent);
  const junks = r.dict(() => readStack(r)).filter(isPresent);
  const consumables = r.dict(() => readStack(r)).filter(isPresent);
  r.dict(() => skipCosmetic(r));
  return { equips, artifacts, cards, gems, junks, consumables };
}
