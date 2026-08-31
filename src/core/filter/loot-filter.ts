/*
 * VENDORED, AND NOW DIVERGED. DO NOT OVERWRITE FROM THE ORIGINAL.
 *
 * Copied from the private project this filter language was written for. It is here because the rule
 * editor in `tools/valeloot-editor/` compiles the REAL matcher into its page rather than a lookalike:
 * a second implementation of these semantics would make the editor agree with the mod only by
 * coincidence. Both copies are MIT and ours.
 *
 * Changed here on purpose: `LootCondition.nameContains` (one string) became `names` (a list, any one
 * matching), with a migration read for stored rules that predate it. The sibling `import type`s come
 * from `./types.ts`, and one citation of an unpublished design document was dropped.
 *
 * In ValeLoot the MOD is authoritative — it decides what the bag actually looks like, and this only
 * predicts it — so a difference between the two is this file's bug, not the mod's. `tools/conformance`
 * fails the build when they disagree; see the header of `loot-dsl.ts`.
 */
/**
 * Loot filters — your rules, your colours, your sounds.
 *
 * Modelled on the loot filters players already know (Path of Exile, Diablo): an ORDERED list of rules,
 * FIRST MATCH WINS, each rule deciding how an item is PRESENTED — a colour, a short tag, how hard it is
 * highlighted in the bag, and whether it makes a noise when it lands. Rules can also `mute`: PoE's
 * `Hide`, for the trash you want the overlay to stop talking about.
 *
 * That ordering is the whole ergonomic trick — you put "triple top roll" above "vendor trash" and stop
 * thinking about overlap.
 *
 * ## Presentation is the entire vocabulary, deliberately
 *
 * A rule cannot ACT on an item. There is no field here that could express dismantling, pickup or any
 * other automation, and the destructive planner that used to sit next to this file is gone. That is a
 * product decision, not an omission: the game's staff allow client-side tools that change "how the loot
 * color is, sound and how it looks in the inventory" and nothing past that line. Keeping the *type*
 * incapable of an action is cheaper than keeping a policy: nothing downstream has to be trusted to
 * check.
 *
 * What a rule can test is deliberately limited to things that are TRUE about the item: its type, its
 * refine, its substat lines and their roll percentages, how many lines clear your top-roll threshold,
 * whether the wiki knows it, and how it compares to what you are wearing. There is no "is it good"
 * heuristic hidden in here — good is whatever your rules say it is.
 *
 * Evaluation is pure and allocation-light: it runs over a few hundred items every time a bag changes,
 * inside an overlay that must not stutter, so it does no string building and no regex compilation per
 * item.
 */

import type { OwnedGear, Verdict } from './types.ts';
/**
 * Collision-free player-facing names for live SpiritVale stats.
 *
 * The internal enum names remain canonical and valid. This table exists at comparison and
 * autocomplete boundaries only; labels that collide with another live internal name are deliberately
 * absent.
 */
export const STAT_ALIASES = [
  { friendly: 'AttackSpeed', internal: 'AtkSpd' },
  { friendly: 'AttackSpeedLimit', internal: 'AtkSpdLimit' },
  { friendly: 'CastSpeed', internal: 'CastSpd' },
  { friendly: 'AutoAttackChain', internal: 'Chain' },
  { friendly: 'MagicDamage', internal: 'DamageMagic' },
  { friendly: 'MeleeDamage', internal: 'DamageMelee' },
  { friendly: 'RangedDamage', internal: 'DamageRanged' },
  { friendly: 'Multistrike', internal: 'DoubleAttack' },
  { friendly: 'HealthLeech', internal: 'Leech' },
  { friendly: 'MovementSpeed', internal: 'MoveSpd' },
] as const;

export function canonicalStatName(input: string): string {
  const match = STAT_ALIASES.find((entry) => entry.friendly.toLowerCase() === input.toLowerCase());
  return match?.internal ?? input;
}


export interface StatCondition {
  stat: string;
  /** Inclusive roll-quality bounds (0..100). Omit both to accept any roll. */
  minRollPct?: number;
  maxRollPct?: number;
  /**
   * Inclusive bounds on the line's VALUE as the game prints it — the `3` in "+3 AGI".
   *
   * Distinct from roll quality, which is where the roll sits in the stat's legal range. A player
   * asking for "kunais with +3 AGI" means this value; "top-roll AGI" means roll quality. Conflating
   * them silently answers a different question than the one asked.
   */
  minValue?: number;
  maxValue?: number;
}

export interface LootCondition {
  /** Item types this rule applies to (`Chest`, `Pistol`, …). Empty/absent = any. */
  slotTypes?: string[];
  /** At least this many lines print their legal maximum value. */
  minTopRolls?: number;
  /** At most this many displayed-max lines. */
  maxTopRolls?: number;
  /** At least this many hidden raw rolls reach `Threshold`. */
  minHighRolls?: number;
  /** At most this many hidden raw rolls reach `Threshold`. */
  maxHighRolls?: number;
  minAvgRollPct?: number;
  maxAvgRollPct?: number;
  minRefine?: number;
  /** Required/candidate substat lines. */
  stats?: StatCondition[];
  /** Stats that must match independently of StatMatches, AnyStat, and AllStats. */
  requiredStats?: StatCondition[];
  /**
   * Each nested array is one `AnyOf` block. Every block must have at least one matching stat,
   * while separate blocks and the rule's ordinary conditions are still ANDed.
   */
  anyOfStats?: StatCondition[][];

  /**
   * Minimum/maximum number of listed `stats` entries that must match.
   * When either is present it replaces `statMode`.
   */
  minStatMatches?: number;
  maxStatMatches?: number;

  /**
   * Whether every listed stat must be present, or just one. Default 'all'.
   * Ignored when a StatMatches bound is present.
   */
  statMode?: 'all' | 'any';
  /** At least this many of the item's stats are ones your worn gear already uses. */
  minSharedStats?: number;
  /** Only items the site's catalog does not know (or only ones it does). */
  unknown?: boolean;
  /**
   * Any of these, as a case-insensitive substring of the item name.
   *
   * A list rather than one string because the commonest real rule is "these few drops I care
   * about", and the alternative is several rules differing in one word. `Type` already reads as a
   * list for the same reason.
   */
  names?: string[];
  /** Only items whose upgrade comparison reached one of these verdicts. */
  verdicts?: Verdict[];
  /** Only items with a Chaos effect—an added extra substat or an over-roll—or only ones without. */
  hasChaos?: boolean;
  /**
   * Only items the player has flagged as a favourite in game (or only ones they have not).
   *
   * The game's own gesture for "don't touch this", and the cheapest signal in the bag because the
   * player already maintains it. Present here because the in-game mod reads the same flag off the item
   * and its starter filter uses it — a condition one side has and the other does not makes a shared
   * file unusable in one of them.
   */
  favorite?: boolean;
  /**
   * Only items with a line above its normal maximum (or only ones without).
   *
   * Reachable only by a Chaos widen, so it is a small and unambiguously interesting population — the
   * client itself branches on the roll exceeding 100. Distinct from `hasChaos`, which says the item HAS
   * a chaos slot; this says the chaos actually bought something.
   */
  overRoll?: boolean;
}

/**
 * How hard a match shouts in the bag.
 *
 *   dot    quiet — the cell carries the rule's colour and tag, nothing more
 *   mark   earns a keep mark: the star the grid draws over slots worth a second look
 *   glow   an animated ring, and the loot row pulses as the item lands
 *
 * Three levels rather than a boolean because the previous boolean (`flash`) had to mean both "worth a
 * star" and "worth an animation", and a bag where 25 of 31 slots are starred says nothing.
 */
export type LootHighlight = 'dot' | 'mark' | 'glow';
export const LOOT_HIGHLIGHTS: readonly LootHighlight[] = ['dot', 'mark', 'glow'];

export type LootBackground = 'border' | 'fill' | 'holo';
export const LOOT_BACKGROUNDS: readonly LootBackground[] = ['border', 'fill', 'holo'];

/**
 * Sounds the overlay can make with nothing on disk: each is synthesised in the HUD's audio graph, so a
 * fresh install has usable sounds and this repo ships no binary assets.
 *
 * Any other value in `LootRule.sound` names a file the player dropped in `<settings dir>/sounds` —
 * "custom sounds" means their file, not a curated pack we have to license.
 */
export const BUILTIN_LOOT_SOUNDS: readonly string[] = ['blip', 'chime', 'ding', 'alert', 'thud'];

/**
 * A sound name that is safe to put in a URL and to resolve inside the sounds directory, or null.
 *
 * Rules are hand-editable JSON and pasted filter text, so this is the one place a name is vetted:
 * no separators, no `..`, no spaces. The HTTP layer resolves files by this name, and a filter that
 * could name `../../secrets` would make the editor a file reader.
 */
export function normalizeSoundName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value) ? value : null;
}

export interface LootRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Base colour used for the border, tag, and optional full-cell background. */
  color: string;
  /** Border-only by default, a solid fill, or a continuously hue-rotating fill. */
  background?: LootBackground;
  /** Keep the rounded selection frame. Absent means true. */
  border?: boolean;
  /** Short tag, e.g. "KEEP". Falls back to the rule name. */
  label?: string;
  /** How loudly to draw a match. Absent means `dot`. */
  highlight?: LootHighlight;
  /**
   * Play this once when a match ARRIVES in the bag — a built-in name or a file in the sounds directory.
   *
   * On arrival only, never on a rescan: the bag is re-evaluated on every exp tick, and a sound that
   * fired per evaluation would be a siren. `Session` emits loot events from a bag DIFF, which is what
   * makes "on arrival" a fact rather than a debounce.
   */
  sound?: string;
  /**
   * Matched, and deliberately silent — PoE's `Hide`.
   *
   * A muted match draws no mark, plays no sound and generates no loot row. It is not "no rule matched":
   * the rule claimed the item and chose silence, which is how a filter stops the overlay narrating
   * every piece of vendor fodder while still letting a later rule be quiet about nothing.
   */
  mute?: boolean;
  when: LootCondition;
}

/** Everything a rule may need to know that is not on the item itself. */
export interface LootContext {
  /** Roll percentage that counts as a top roll — the same threshold the inventory view used. */
  threshold: number;
  /** Stats your worn gear uses, for `minSharedStats`. */
  wornStats?: ReadonlySet<string>;
  /** Upgrade verdicts by item uid, for `verdicts`. */
  verdictByUid?: ReadonlyMap<string, Verdict>;
}

export interface LootMatch {
  ruleId: string;
  name: string;
  color: string;
  label: string;
  highlight: LootHighlight;
  background: LootBackground;
  border: boolean;
  /** Null when the rule asks for no sound — the common case. */
  sound: string | null;
  mute: boolean;
}

/**
 * Sensible defaults, ordered the way a player would order them. Everything here is editable and
 * removable — these exist so the overlay is useful the first time it runs, not to encode taste.
 *
 * Only the two rules a player would want to hear about carry a sound, and nothing is muted: a first
 * run should show what it can see, and going quiet is a choice the player makes about their own bag.
 */
export function defaultLootRules(): LootRule[] {
  return [
    {
      id: 'triple', name: 'Triple top roll', enabled: true, color: '#e9c46a', label: 'TRIPLE',
      highlight: 'glow', sound: 'chime',
      when: { minTopRolls: 3 },
    },
    {
      id: 'upgrade', name: 'Beats what I wear', enabled: true, color: '#4ade80', label: 'UPGRADE',
      highlight: 'glow', sound: 'ding',
      when: { verdicts: ['upgrade'] },
    },
    {
      id: 'double', name: 'Two top rolls', enabled: true, color: '#7cc0ff', label: 'KEEP',
      highlight: 'mark',
      when: { minTopRolls: 2 },
    },
    {
      id: 'mystat', name: 'Rolls my stats well', enabled: true, color: '#a78bfa', label: 'MINE',
      highlight: 'mark',
      when: { minSharedStats: 2, minAvgRollPct: 60 },
    },
    {
      id: 'unknown', name: 'Not in the wiki', enabled: true, color: '#f0b429', label: 'NEW?',
      highlight: 'dot',
      when: { unknown: true },
    },
    {
      id: 'vendor', name: 'Vendor / essence fodder', enabled: true, color: '#6b7a73', label: 'JUNK',
      highlight: 'dot',
      when: { maxAvgRollPct: 35, maxHighRolls: 0 },
    },
  ];
}

/**
 * First enabled rule that matches, or null.
 *
 * A muted rule still MATCHES — the match carries `mute: true` and callers honour it. Returning null for
 * a mute would make "the filter deliberately silenced this" indistinguishable from "no rule claimed
 * it", which is exactly the distinction a filter author is debugging when a rule looks dead.
 */
export function matchLoot(item: OwnedGear, rules: readonly LootRule[], context: LootContext): LootMatch | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesCondition(item, rule.when, context)) continue;
    return {
      ruleId: rule.id,
      name: rule.name,
      color: rule.color,
      label: rule.label ?? rule.name,
      background: rule.background ?? 'border',
      border: rule.border !== false,
      highlight: rule.highlight ?? 'dot',
      sound: rule.sound ?? null,
      mute: Boolean(rule.mute),
    };
  }
  return null;
}

function matchesStat(item: OwnedGear, condition: StatCondition): boolean {
  const wanted = canonicalStatName(condition.stat).toLowerCase();
  const line = item.lines.find((candidate) => candidate.stat.toLowerCase() === wanted);
  return Boolean(line)
    && (condition.minRollPct === undefined
      || (line!.rollPct !== null && line!.rollPct >= condition.minRollPct))
    && (condition.maxRollPct === undefined
      || (line!.rollPct !== null && line!.rollPct <= condition.maxRollPct))
    && (condition.minValue === undefined || line!.base >= condition.minValue)
    && (condition.maxValue === undefined || line!.base <= condition.maxValue);
}

export function matchesCondition(item: OwnedGear, when: LootCondition, context: LootContext): boolean {
  if (when.slotTypes?.length && !when.slotTypes.includes(item.slotType)) return false;
  if ((when.minTopRolls !== undefined || when.maxTopRolls !== undefined) && item.topRolls === null) return false;
  if (when.minTopRolls !== undefined && item.topRolls! < when.minTopRolls) return false;
  if (when.maxTopRolls !== undefined && item.topRolls! > when.maxTopRolls) return false;
  if (when.minHighRolls !== undefined && item.highRolls < when.minHighRolls) return false;
  if (when.maxHighRolls !== undefined && item.highRolls > when.maxHighRolls) return false;
  if (when.minRefine !== undefined && item.refine < when.minRefine) return false;
  if (when.unknown !== undefined && Boolean(item.unknown) !== when.unknown) return false;
  if (when.favorite !== undefined && item.favorite !== when.favorite) return false;

  if (when.minAvgRollPct !== undefined && (item.avgRollPct ?? -1) < when.minAvgRollPct) return false;
  // An unplaceable average must not slip through a "junk" ceiling — treat it as unknown, not as 0.
  if (when.maxAvgRollPct !== undefined
      && (item.avgRollPct === null || item.avgRollPct > when.maxAvgRollPct)) return false;

  if (when.names?.length) {
    const name = item.name.toLowerCase();
    if (!when.names.some((want) => name.includes(want.toLowerCase()))) return false;
  }

  if (when.hasChaos !== undefined) {
    const hasChaos = item.hasChaos === true || item.lines.some((line) => line.over)
      ? true : item.hasChaos;
    if (hasChaos === null || hasChaos !== when.hasChaos) return false;
  }

  if (when.overRoll !== undefined) {
    const over = item.lines.some((line) => line.over);
    if (over !== when.overRoll) return false;
  }

  if (when.requiredStats?.length) {
    for (const condition of when.requiredStats) {
      if (!matchesStat(item, condition)) return false;
    }
  }

  const boundedStatMatches =
    when.minStatMatches !== undefined ||
    when.maxStatMatches !== undefined;

  if (when.stats?.length) {
    const mode = when.statMode ?? 'all';
    let hits = 0;
    for (const condition of when.stats) {
      /**
       * Stat names match without regard to case.
       *
       * These are hand-typed into a rule, and the catalog's spelling is `Dex` while every player will
       * write `DEX` at least once. An exact comparison made that rule match NOTHING, with no error and
       * nothing on screen to say why — the rule simply sat there looking enabled. A filter that fails
       * silently on capitalisation is a trap, and nothing here needs `Dex` and `DEX` to be different.
       */
      const ok = matchesStat(item, condition);
      if (ok) hits++;
      else if (!boundedStatMatches && mode === 'all') return false;
    }

    if (boundedStatMatches) {
        if (
            when.minStatMatches !== undefined &&
            hits < when.minStatMatches
        ) {
            return false;
        }

        if (
            when.maxStatMatches !== undefined &&
            hits > when.maxStatMatches
        ) {
            return false;
        }
    } else if (mode === 'any' && hits === 0) {
        return false;
    }
    } else if (boundedStatMatches) {
        // Fail closed for programmatically-created rules that bypass the text parser.
        return false;
    }
  if (when.anyOfStats?.length) {
    for (const group of when.anyOfStats) {
      let matched = false;
      for (const condition of group) {
        if (!matchesStat(item, condition)) continue;
        matched = true;
        break;
      }
      if (!matched) return false;
    }
  }


  if (when.minSharedStats !== undefined) {
    const worn = context.wornStats;
    if (!worn) return false;
    let shared = 0;
    // Same spelling rule as above: the worn set comes from the same catalog today, but a caller that
    // assembles it differently must not silently score zero shared stats.
    const wornLower = new Set([...worn].map((stat) => stat.toLowerCase()));
    for (const line of item.lines) if (wornLower.has(line.stat.toLowerCase())) shared++;
    if (shared < when.minSharedStats) return false;
  }

  if (when.verdicts?.length) {
    const verdict = item.uid ? context.verdictByUid?.get(item.uid) : undefined;
    if (!verdict || !when.verdicts.includes(verdict)) return false;
  }

  return true;
}

export type ConditionCheckStatus = 'pass' | 'fail' | 'unavailable';

export interface ConditionCheck {
  key: string;
  label: string;
  expected: string;
  actual: string;
  status: ConditionCheckStatus;
}

export interface ConditionExplanation {
  matches: boolean;
  available: boolean;
  checks: ConditionCheck[];
}

/**
 * Explain every active condition without changing matcher semantics.
 *
 * `matchesCondition` remains the allocation-free hot path. This diagnostic path calls it for the
 * authoritative result, then materialises player-facing checks only when the editor asks for them.
 */
export function explainCondition(
  item: OwnedGear,
  when: LootCondition,
  context: LootContext,
): ConditionExplanation {
  const checks: ConditionCheck[] = [];
  const add = (
    key: string,
    label: string,
    expected: string,
    actual: string,
    pass: boolean,
    unavailable = false,
  ) => checks.push({
    key,
    label,
    expected,
    actual,
    status: unavailable ? 'unavailable' : pass ? 'pass' : 'fail',
  });

  if (when.slotTypes?.length) {
    add('type', 'Type', when.slotTypes.join(' or '), item.slotType || 'unknown',
      when.slotTypes.includes(item.slotType));
  }
  if (when.names?.length) {
    const actual = item.name || item.itemId || 'unknown';
    const lower = item.name.toLowerCase();
    add('name', 'Name contains', when.names.join(' or '), actual,
      when.names.some((wanted) => lower.includes(wanted.toLowerCase())));
  }
  if (when.minRefine !== undefined) {
    add('refine-min', 'Refine', `at least ${when.minRefine}`, String(item.refine),
      item.refine >= when.minRefine);
  }
  if (when.minTopRolls !== undefined) {
    add('top-min', 'Top rolls', `at least ${when.minTopRolls}`,
      item.topRolls === null ? 'not recorded' : String(item.topRolls),
      item.topRolls !== null && item.topRolls >= when.minTopRolls, item.topRolls === null);
  }
  if (when.maxTopRolls !== undefined) {
    add('top-max', 'Top rolls', `at most ${when.maxTopRolls}`,
      item.topRolls === null ? 'not recorded' : String(item.topRolls),
      item.topRolls !== null && item.topRolls <= when.maxTopRolls, item.topRolls === null);
  }
  if (when.minHighRolls !== undefined) {
    add('high-min', `Rolls at ${context.threshold}%`, `at least ${when.minHighRolls}`,
      String(item.highRolls), item.highRolls >= when.minHighRolls);
  }
  if (when.maxHighRolls !== undefined) {
    add('high-max', `Rolls at ${context.threshold}%`, `at most ${when.maxHighRolls}`,
      String(item.highRolls), item.highRolls <= when.maxHighRolls);
  }
  if (when.minAvgRollPct !== undefined) {
    add('average-min', 'Average roll', `at least ${when.minAvgRollPct}%`,
      item.avgRollPct === null ? 'not recorded' : `${Math.round(item.avgRollPct)}%`,
      item.avgRollPct !== null && item.avgRollPct >= when.minAvgRollPct, item.avgRollPct === null);
  }
  if (when.maxAvgRollPct !== undefined) {
    add('average-max', 'Average roll', `at most ${when.maxAvgRollPct}%`,
      item.avgRollPct === null ? 'not recorded' : `${Math.round(item.avgRollPct)}%`,
      item.avgRollPct !== null && item.avgRollPct <= when.maxAvgRollPct, item.avgRollPct === null);
  }
  if (when.unknown !== undefined) {
    add('known', 'Catalog status', when.unknown ? 'unknown' : 'known',
      item.unknown ? 'unknown' : 'known', Boolean(item.unknown) === when.unknown);
  }
  if (when.favorite !== undefined) {
    add('favorite', 'Favourite', when.favorite ? 'yes' : 'no',
      item.favorite ? 'yes' : 'no', item.favorite === when.favorite);
  }
  if (when.hasChaos !== undefined) {
    const over = item.lines.some((line) => line.over);
    const hasChaos = item.hasChaos === true || over ? true : item.hasChaos;
    add('chaos', 'Chaos', when.hasChaos ? 'present' : 'absent',
      hasChaos === null ? 'not recorded' : hasChaos ? 'present' : 'absent',
      hasChaos !== null && hasChaos === when.hasChaos, hasChaos === null);
  }
  if (when.overRoll !== undefined) {
    const over = item.lines.some((line) => line.over);
    add('overroll', 'Over-roll', when.overRoll ? 'present' : 'absent',
      over ? 'present' : 'absent', over === when.overRoll);
  }

  const statBounds = (condition: StatCondition): string => {
    const parts: string[] = [];
    if (condition.minRollPct !== undefined
      && condition.maxRollPct !== undefined
      && condition.minRollPct === condition.maxRollPct) {
      parts.push(`roll exactly ${condition.minRollPct}%`);
    } else {
      if (condition.minRollPct !== undefined) parts.push(`roll at least ${condition.minRollPct}%`);
      if (condition.maxRollPct !== undefined) parts.push(`roll at most ${condition.maxRollPct}%`);
    }
    if (condition.minValue !== undefined
      && condition.maxValue !== undefined
      && condition.minValue === condition.maxValue) {
      parts.push(`value exactly ${condition.minValue}`);
    } else {
      if (condition.minValue !== undefined) parts.push(`value at least ${condition.minValue}`);
      if (condition.maxValue !== undefined) parts.push(`value at most ${condition.maxValue}`);
    }
    return parts.join(', ') || 'present';
  };

  for (const condition of when.requiredStats ?? []) {
    const pass = matchesStat(item, condition);
    const bounds = statBounds(condition);
    const line = item.lines.find((candidate) =>
      candidate.stat.toLowerCase() === canonicalStatName(condition.stat).toLowerCase());
    const actual = !line ? 'missing'
      : `${line.base}${line.rollPct === null ? '' : ` · ${Math.round(line.rollPct)}%`}`;
    add(`required-stat-${condition.stat}`, `Required ${condition.stat}`, bounds, actual, pass);
  }

  const boundedStats = when.minStatMatches !== undefined || when.maxStatMatches !== undefined;
  let statHits = 0;
  if (when.stats?.length) {
    for (const condition of when.stats) {
      const pass = matchesStat(item, condition);
      if (pass) statHits++;
      const bounds = statBounds(condition);
      const line = item.lines.find((candidate) =>
        candidate.stat.toLowerCase() === canonicalStatName(condition.stat).toLowerCase());
      const actual = !line ? 'missing'
        : `${line.base}${line.rollPct === null ? '' : ` · ${Math.round(line.rollPct)}%`}`;
      add(`stat-${condition.stat}`, condition.stat, bounds, actual, pass);
    }
    if (boundedStats) {
      if (when.minStatMatches !== undefined) {
        add('statmatches-min', 'Matching stats', `at least ${when.minStatMatches}`,
          String(statHits), statHits >= when.minStatMatches);
      }
      if (when.maxStatMatches !== undefined) {
        add('statmatches-max', 'Matching stats', `at most ${when.maxStatMatches}`,
          String(statHits), statHits <= when.maxStatMatches);
      }
    } else if (when.statMode === 'any') {
      add('statmode-any', 'Listed stats', 'at least one', `${statHits} matched`, statHits > 0);
    }
  } else if (boundedStats) {
    add('statmatches-missing', 'Matching stats', 'a Stat list', 'no Stat lines', false);
  }

  for (let groupIndex = 0; groupIndex < (when.anyOfStats?.length ?? 0); groupIndex++) {
    const group = when.anyOfStats![groupIndex];
    if (!group) continue;
    const hits = group.filter((condition) => matchesStat(item, condition)).length;
    add(`anyof-${groupIndex}`, `AnyOf ${groupIndex + 1}`,
      group.map((condition) => condition.stat).join(' or '), `${hits} matched`, hits > 0);
  }

  if (when.minSharedStats !== undefined) {
    const worn = context.wornStats;
    let shared = 0;
    if (worn) {
      const lower = new Set([...worn].map((stat) => stat.toLowerCase()));
      for (const line of item.lines) if (lower.has(line.stat.toLowerCase())) shared++;
    }
    add('shared', 'Shared stats', `at least ${when.minSharedStats}`,
      worn ? String(shared) : 'worn gear unavailable',
      Boolean(worn) && shared >= when.minSharedStats, !worn);
  }
  if (when.verdicts?.length) {
    const verdict = item.uid ? context.verdictByUid?.get(item.uid) : undefined;
    add('verdict', 'Verdict', when.verdicts.join(' or '), verdict ?? 'unavailable',
      verdict !== undefined && when.verdicts.includes(verdict), verdict === undefined);
  }

  return {
    matches: matchesCondition(item, when, context),
    available: checks.every((check) => check.status !== 'unavailable'),
    checks,
  };
}

/**
 * Repair a rule list from disk: drop nonsense, keep order, never throw on a hand-edited file.
 *
 * It is also the migration for rule files written before this engine was presentation-only:
 *
 *   `flash: true`         -> `highlight: 'glow'`  (the animation the flag used to mean)
 *   `action: 'dismantle'` -> `mute: true`         (see below)
 *
 * The action mapping is a judgement, stated so it can be argued with: a player who typed out
 * "dismantle this" was describing a bucket of items they do not want, and the nearest thing this engine
 * can still express about it is "stop showing it to me". The rule keeps its colour and tag, so nothing
 * is lost that cannot be turned back on by clearing one checkbox — and no configuration on disk can
 * make anything happen to an item any more.
 */
export function normalizeLootRules(input: unknown): LootRule[] {
  if (!Array.isArray(input)) return defaultLootRules();
  const rules: LootRule[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<LootRule> & { flash?: unknown; action?: unknown };
    const id = typeof candidate.id === 'string' && candidate.id ? candidate.id : `rule-${rules.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const highlight: LootHighlight = LOOT_HIGHLIGHTS.includes(candidate.highlight as LootHighlight)
      ? candidate.highlight as LootHighlight
      : candidate.flash ? 'glow' : 'dot';
    const background: LootBackground = LOOT_BACKGROUNDS.includes(candidate.background as LootBackground)
      ? candidate.background as LootBackground
      : 'border';
    const sound = normalizeSoundName(candidate.sound);
    rules.push({
      id,
      name: typeof candidate.name === 'string' && candidate.name ? candidate.name.slice(0, 40) : id,
      enabled: candidate.enabled !== false,
      color: /^#[0-9a-f]{6}$/i.test(String(candidate.color)) ? String(candidate.color) : '#4ade80',
      ...(candidate.label ? { label: String(candidate.label).slice(0, 12) } : {}),
      highlight,
      background,
      border: candidate.border !== false,
      ...(sound ? { sound } : {}),
      ...(candidate.mute === true || candidate.action === 'dismantle' ? { mute: true } : {}),
      when: normalizeCondition(candidate.when),
    });
  }
  return rules.length ? rules : defaultLootRules();
}

function normalizeCondition(input: unknown): LootCondition {
  const raw = (input ?? {}) as Partial<LootCondition>;
  const when: LootCondition = {};
  if (Array.isArray(raw.slotTypes)) when.slotTypes = raw.slotTypes.filter((value): value is string => typeof value === 'string');
  for (const key of [
    'minTopRolls', 'maxTopRolls', 'minHighRolls', 'maxHighRolls',
    'minAvgRollPct', 'maxAvgRollPct', 'minRefine', 'minSharedStats',
    'minStatMatches', 'maxStatMatches',
  ] as const) {
    const rawValue = raw[key];
    if (rawValue === null || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) when[key] = value;
  }
  if (typeof raw.overRoll === 'boolean') when.overRoll = raw.overRoll;
  if (typeof raw.unknown === 'boolean') when.unknown = raw.unknown;
  if (typeof raw.hasChaos === 'boolean') when.hasChaos = raw.hasChaos;
  if (typeof raw.favorite === 'boolean') when.favorite = raw.favorite;
  // Both spellings are read, because rules are hand-editable JSON that may predate the list form.
  // `nameContains` is no longer on the type, so it is reached through the untyped input — that is
  // the point of a migration read. Only the list is ever written back out, so a file round-trips
  // into the current shape once.
  const legacy = (input ?? {}) as { nameContains?: unknown };
  const names = Array.isArray(raw.names)
    ? raw.names
    : typeof legacy.nameContains === 'string' && legacy.nameContains ? [legacy.nameContains] : [];
  const cleaned = names
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => entry.slice(0, 40));
  if (cleaned.length) when.names = cleaned;
  if (raw.statMode === 'any' || raw.statMode === 'all') when.statMode = raw.statMode;
  const normalizeStats = (value: unknown): StatCondition[] => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is StatCondition =>
        Boolean(entry) && typeof (entry as StatCondition).stat === 'string')
      .map((entry) => {
        const min = Number(entry.minRollPct);
        const printed = Number(entry.minValue);
        return {
          stat: canonicalStatName(entry.stat),
          ...(Number.isFinite(min) ? { minRollPct: Math.max(0, Math.min(100, min)) } : {}),
          ...(Number.isFinite(printed) ? { minValue: printed } : {}),
        };
      });
  };
  const requiredStats = normalizeStats(raw.requiredStats);
  if (requiredStats.length) when.requiredStats = requiredStats;
  const stats = normalizeStats(raw.stats);
  if (stats.length) when.stats = stats;
  if (Array.isArray(raw.anyOfStats)) {
    when.anyOfStats = raw.anyOfStats
      .map(normalizeStats)
      .filter((group) => group.length > 0);
    if (!when.anyOfStats.length) delete when.anyOfStats;
  }
  if (Array.isArray(raw.verdicts)) {
    const allowed: Verdict[] = ['upgrade', 'better-rolls', 'sidegrade', 'worse'];
    when.verdicts = raw.verdicts.filter((value): value is Verdict => allowed.includes(value as Verdict));
  }
  return when;
}

/** A bag snapshot reduced to what identity comparison needs. */
export type OwnedIndex = ReadonlyMap<string, string>;

export function indexOwned(gear: readonly OwnedGear[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const item of gear) if (item.uid) index.set(item.uid, item.itemId);
  return index;
}

/**
 * What changed between two bag snapshots.
 *
 * Item UIDs are stable per instance, so an added UID is genuinely a NEW item — the loot event. This is
 * why loot detection needs no extra protocol work: the server re-sends the character on every bag
 * mutation, so a diff of consecutive snapshots is the pickup, complete with its rolls.
 *
 * The FIRST snapshot is not a loot event. Treating a freshly-attached session as "you just looted 400
 * items" would bury the player in flashes, so callers pass `seeded: false` for the first one.
 */
export function diffOwned(previous: OwnedIndex | null, current: readonly OwnedGear[]): { added: OwnedGear[]; removedUids: string[] } {
  if (!previous) return { added: [], removedUids: [] };
  const added: OwnedGear[] = [];
  const seen = new Set<string>();
  for (const item of current) {
    if (!item.uid) continue;
    seen.add(item.uid);
    if (!previous.has(item.uid)) added.push(item);
  }
  const removedUids: string[] = [];
  for (const uid of previous.keys()) if (!seen.has(uid)) removedUids.push(uid);
  return { added, removedUids };
}
