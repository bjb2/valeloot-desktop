/*
 * VENDORED, AND NOW DIVERGED. DO NOT OVERWRITE FROM THE ORIGINAL.
 *
 * Copied from the private project this filter language was written for. It is here because the rule
 * editor in `tools/valeloot-editor/` compiles the REAL parser into its page rather than a lookalike:
 * a third implementation of this grammar (after this one and the mod's C# in
 * `mod/ValeLoot/FilterParser.cs`) would turn every grammar change into a three-way merge. Both
 * copies are MIT and ours.
 *
 * ## What has changed here, and why re-copying would be a regression
 *
 * This copy is no longer the original, and the differences are deliberate. In ValeLoot the mod is
 * AUTHORITATIVE — it decides what the player's bag actually looks like — and this parser's only job
 * is to predict it. Where the two read a line differently, this one is wrong by definition.
 *
 *   - `Name` takes a comma-separated list, any one matching.
 *   - `Stat X > 7` excludes 7 (the original folded `>` into `>=`).
 *   - `AvgRollPct` bounds are integral, because the mod compares whole percents.
 *
 * The sibling `import type`s also come from `./types.ts` (see that file).
 *
 * `tools/conformance` parses a corpus with BOTH implementations and fails the build if they
 * disagree, so a careless re-sync is caught rather than shipped. It found the last two of those
 * three the day it was written.
 */
/**
 * The loot filter language — a PoE-style block filter you paste in.
 *
 * It is a FRONT END, not a second engine: it compiles to the same `LootRule[]` and overrides the JSON
 * model already uses, so the planner, its tests and the rules editor are unchanged and there is exactly
 * one place where matching semantics live.
 *
 * ```
 * # Kunais are only worth keeping with real AGI on them
 * Show "Kunai keepers"
 *     Name      Kunai
 *     Stat      Agi >= 3
 *     Tag       KEEP
 *     Highlight glow
 *     Sound     chime
 *
 * Show "Master swords"
 *     Name      "Master Sword"
 *     Stat      Str >= 3
 *
 * Hide "vendor trash"
 *     AvgRollPct < 35
 *     HighRolls  < 1
 *
 * AlwaysShow "Spirit Ward", "Windborne Rune"
 * AlwaysHide "Rusty Dagger"
 * ```
 *
 * ## Show and Hide are the only verbs
 *
 * `Show` decides how an item is PRESENTED — colour, tag, highlight level, sound. `Hide` claims an item
 * in order to say nothing about it. Neither does anything TO the item; the language has no verb that
 * could, which is the point (see the header of `loot-filter.ts`).
 *
 * Filters written against the earlier, destructive vocabulary still parse: `Keep` reads as `Show`,
 * `Dismantle` as `Hide` (a bucket of items you do not want, presented as silence), `AlwaysKeep` /
 * `AlwaysDismantle` as `AlwaysShow` / `AlwaysHide`, and `Flash` as `Highlight glow`. `Protect` is
 * refused with a message rather than silently ignored: its whole job was gating a destructive step that
 * no longer exists, and a filter that still lists protections is describing a tool this is not.
 *
 * ## `>= 3` versus `>= 90%`
 *
 * The `%` suffix is the whole disambiguation, and it matters more than it looks:
 *
 *   Stat Agi >= 3      the line's VALUE — the "+3" the game prints
 *   Stat Agi >= 90%    the line's ROLL QUALITY — top 10% of AGI's legal range
 *
 * "Kunais with +3 AGI" is the first. Silently answering with the second would filter on a different
 * question than the one asked, and look like it worked.
 *
 * ## Why a bad line is a hard error, not a skipped line
 *
 * Ignoring an unparseable condition WIDENS the block it was in — drop `AvgRollPct < 35` from a `Hide` block
 * and it swallows everything you own, so the bag goes dark and the filter looks broken rather than
 * misread. So a block with any bad line is REJECTED WHOLE and reported with its line number, and
 * `parseLootFilter` never emits a partially-understood rule.
 */
import {
  LOOT_BACKGROUNDS, LOOT_HIGHLIGHTS, canonicalStatName, normalizeSoundName,
  type LootBackground, type LootCondition, type LootHighlight, type LootRule, type StatCondition,
} from './loot-filter.ts';
import type { ItemOverrides, Verdict } from './types.ts';

export interface FilterError {
  line: number;
  text: string;
  message: string;
}

export interface ParsedFilter {
  rules: LootRule[];
  overrides: ItemOverrides;
  errors: FilterError[];
  /**
   * What counts as a top roll, if the file says.
   *
   * It lives in the TEXT rather than only in a host application's settings because the file is now a
   * shared artifact: the mod reads the same bytes and takes its threshold from them, so a filter that
   * means "triple top roll at 95" has to be able to say so in a form that travels. Absent means "use
   * the caller's".
   */
  threshold?: number;
}

const VERDICTS: readonly string[] = ['upgrade', 'better-rolls', 'sidegrade', 'worse'];

/** Block openers, including the spellings a filter written before this engine was cosmetic may carry. */
const BLOCK_KEYWORDS: Record<string, 'show' | 'hide'> = {
  show: 'show', keep: 'show',
  hide: 'hide', mute: 'hide', dismantle: 'hide',
};

/** One-line per-item directives, same aliasing. */
const OVERRIDE_KEYWORDS: Record<string, keyof ItemOverrides> = {
  alwaysshow: 'pin', alwayskeep: 'pin',
  alwayshide: 'mute', alwaysmute: 'mute', alwaysdismantle: 'mute',
};

interface Block {
  kind: 'show' | 'hide';
  name: string;
  startLine: number;
  body: Array<{ line: number; text: string; indent: number }>;
}

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

/** Split `"a", "b", c` into `['a','b','c']`, honouring quotes. */
function splitList(value: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|([^,]+)/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    // The unquoted branch can swallow a following item's quotes (`, "b"` matches as ` "b"`), so
    // every piece is unquoted after trimming rather than trusting which branch matched.
    const piece = unquote((match[1] ?? match[2] ?? '').trim());
    if (piece) out.push(piece);
  }
  return out;
}

export function parseLootFilter(text: string): ParsedFilter {
  const errors: FilterError[] = [];
  const rules: LootRule[] = [];
  const pin: string[] = [];
  const mute: string[] = [];
  let threshold: number | undefined;

  const blocks: Block[] = [];
  let current: Block | null = null;
  /** Set by a refused block, so its body is swallowed instead of reported line by line. */
  let skipping = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    /**
     * `#` starts a comment — except when it starts a colour.
     *
     * Stripping every `#` to end of line made the documented `Color #4ade80` decoration impossible to
     * write: the value vanished and the line reported "Color needs #rrggbb", so the one decoration a
     * player is most likely to reach for was the one that could not work. A `#` followed by exactly six
     * hex digits is a value, anything else opens a comment — and `Color #4ade80  # nicer green` still
     * works, because the scan continues past the colour.
     */
    const stripped = raw.replace(/(^|\s)#(?![0-9a-fA-F]{6}\b).*$/, '$1');
    const trimmed = stripped.trim();
    if (!trimmed) continue;

    const indented = /^\s/.test(stripped);
    const [head, ...rest] = trimmed.split(/\s+/);
    const keyword = (head ?? '').toLowerCase();
    const remainder = rest.join(' ').trim();

    // One-line directives; valid at any indentation because they open no block.
    const override = OVERRIDE_KEYWORDS[keyword];
    if (override) {
      const ids = splitList(remainder);
      if (!ids.length) errors.push({ line: i + 1, text: trimmed, message: `${head} needs at least one item name` });
      (override === 'pin' ? pin : mute).push(...ids);
      current = null;
      skipping = false;
      continue;
    }

    /**
     * `Threshold 90` — what counts as a high raw roll, for every `HighRolls` line below it.
     *
     * A file-level directive rather than a per-rule one, because it defines one cutoff shared by
     * the filter. `TopRolls` does not use it: top means the maximum displayed value for that stat.
     */
    if (keyword === 'threshold') {
      const value = Number(remainder);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        errors.push({
          line: i + 1, text: trimmed,
          message: 'Threshold needs a whole percentage from 1 to 100, e.g. "Threshold 90"',
        });
      } else {
        threshold = value;
      }
      current = null;
      skipping = false;
      continue;
    }

    if (!indented && keyword === 'protect') {
      errors.push({
        line: i + 1, text: trimmed,
        message: 'Protect is gone — no rule can act on an item any more, so there is nothing to protect against. Delete the block.',
      });
      current = null;
      skipping = true;
      continue;
    }

    const kind = BLOCK_KEYWORDS[keyword];
    if (!indented && kind) {
      current = { kind, name: unquote(remainder) || kind, startLine: i + 1, body: [] };
      blocks.push(current);
      skipping = false;
      continue;
    }

    if (!current) {
      if (skipping) continue;
      errors.push({ line: i + 1, text: trimmed, message: `"${head}" is not inside a Show or Hide block` });
      continue;
    }
    current.body.push({
      line: i + 1,
      text: trimmed,
      indent: stripped.length - stripped.trimStart().length,
    });
  }

  for (const block of blocks) {
    const result = parseRuleBlock(block, rules.length);
    if (result.errors.length) {
      errors.push(...result.errors);
      // Whole-block rejection: a half-understood block matches more than it was told to.
      continue;
    }
    rules.push(result.rule);
  }

  return {
    rules,
    overrides: { pin: [...new Set(pin)], mute: [...new Set(mute)] },
    errors,
    ...(threshold === undefined ? {} : { threshold }),
  };
}

function parseRuleBlock(block: Block, index: number): { rule: LootRule; errors: FilterError[] } {
  const errors: FilterError[] = [];
  const when: LootCondition = {};
  const stats: StatCondition[] = [];
  const requiredStats: StatCondition[] = [];
  const anyOfStats: StatCondition[][] = [];
  let color = block.kind === 'hide' ? '#6b7a73' : '#4ade80';
  let label: string | undefined;
  let highlight: LootHighlight | undefined;
  let background: LootBackground = 'border';
  let border = true;
  let sound: string | undefined;
  let statModeExplicit = false;
  let statMatchesLine: number | undefined;
  let statMatchesText = '';
  const parseStat = (line: number, text: string, remainder: string): StatCondition | undefined => {
    const match = /^(\S+)\s*([<>]=?|=)\s*(-?\d+(?:\.\d+)?)(%?)$/.exec(remainder);
    if (!match) {
      errors.push({ line, text, message: 'Stat needs e.g. "Stat Agi >= 3" (value) or "Stat Agi <= 90%" (roll quality)' });
      return undefined;
    }
    const [, stat, op, rawValue, percent] = match;
    const raw = Number(rawValue);
    let min: number | undefined;
    let max: number | undefined;
    if (op === '=') {
      if (!Number.isInteger(raw)) {
        errors.push({ line, text, message: 'Stat equality needs a whole number because displayed values and roll percentages are integral' });
        return undefined;
      }
      min = raw;
      max = raw;
    } else if (op === '>=') min = Math.ceil(raw);
    else if (op === '>') min = Math.floor(raw) + 1;
    else if (op === '<=') max = Math.floor(raw);
    else max = Math.ceil(raw) - 1;

    const condition: StatCondition = { stat: canonicalStatName(stat!) };
  if (percent) {
    if (min !== undefined) condition.minRollPct = min;
    if (max !== undefined) condition.maxRollPct = max;
  } else {
    if (min !== undefined) condition.minValue = min;
    if (max !== undefined) condition.maxValue = max;
  }
    return condition;
  };


  /**
   * Parse `>= 60` into an inclusive bound.
   *
   * `integral` matters: for a COUNT, `> 2` is `>= 3` and `< 1` is `<= 0`, exactly.
   *
   * Percentages used to treat the strict forms as inclusive, which read as a bug the moment it was
   * seen on real data: `AvgRollPct < 35` listed an item displayed as "avg 35%". Whether that item was
   * 34.6 (correct) or exactly 35.0 (the compromise leaking) is indistinguishable to the player, and
   * a filter you cannot trust at the boundary is a filter you cannot trust. `<` and `>` are now
   * genuinely exclusive, nudged by a value far below display precision but far above float noise.
   */
  const bound = (
    text: string,
    line: number,
    remainder: string,
    integral: boolean,
    apply: (min: number | undefined, max: number | undefined) => void,
  ): void => {
    const match = /^([<>]=?|=)\s*(-?\d+(?:\.\d+)?)$/.exec(remainder);
    if (!match) { errors.push({ line, text, message: `needs a comparison like ">= 60", got "${remainder}"` }); return; }
    const op = match[1]!;
    const value = Number(match[2]);
    if (op === '=') { apply(value, value); return; }
    if (op === '>=') { apply(value, undefined); return; }
    // 1e-9: smaller than any roll percentage a player can perceive, larger than accumulated
    // float error on values in the 0..100 range.
    const nudge = 1e-9;
    if (op === '>') { apply(integral ? value + 1 : value + nudge, undefined); return; }
    if (op === '<=') { apply(undefined, value); return; }
    apply(undefined, integral ? value - 1 : value - nudge);
  };

  for (let bodyIndex = 0; bodyIndex < block.body.length; bodyIndex++) {
    const { line, text, indent } = block.body[bodyIndex]!;
    const [head, ...rest] = text.split(/\s+/);
    const keyword = (head ?? '').toLowerCase();
    const remainder = rest.join(' ').trim();

    if (keyword === 'anyof') {
      if (remainder) {
        errors.push({ line, text, message: 'AnyOf takes no value; indent Stat conditions beneath it' });
      }

      const group: StatCondition[] = [];
      while (bodyIndex + 1 < block.body.length && block.body[bodyIndex + 1]!.indent > indent) {
        const child = block.body[++bodyIndex]!;
        const [childHead, ...childRest] = child.text.split(/\s+/);
        if ((childHead ?? '').toLowerCase() !== 'stat') {
          errors.push({
            line: child.line,
            text: child.text,
            message: 'AnyOf currently accepts only Stat conditions',
          });
          continue;
        }
        const condition = parseStat(child.line, child.text, childRest.join(' ').trim());
        if (condition) group.push(condition);
      }

      if (!group.length) {
        errors.push({ line, text, message: 'AnyOf requires at least one indented Stat condition' });
      } else {
        anyOfStats.push(group);
      }
      continue;
    }

    switch (keyword) {
      case 'name':
        // `splitList` and not `unquote`: only a COMMA separates, so `Name Vampiric Fang Clip` is
        // still one piece and every filter written before Name took a list reads the same.
        when.names = splitList(remainder);
        if (!when.names.length) errors.push({ line, text, message: 'Name needs a value' });
        break;
      case 'type':
        when.slotTypes = splitList(remainder);
        if (!when.slotTypes.length) errors.push({ line, text, message: 'Type needs at least one item type' });
        break;
      case 'stat': {
        const condition = parseStat(line, text, remainder);
        if (condition) stats.push(condition);
        break;
      }
      case 'requirestat': {
        const condition = parseStat(line, text, remainder);
        if (condition) requiredStats.push(condition);
        break;
      }
      case 'anystat':
        if (statMatchesLine !== undefined) {
          errors.push({
            line,
            text,
            message: 'AnyStat cannot be combined with StatMatches — StatMatches already defines how listed Stat lines are aggregated',
          });
        } else {
          when.statMode = 'any';
          statModeExplicit = true;
        }
        break;

      case 'allstats':
        if (statMatchesLine !== undefined) {
          errors.push({
            line,
            text,
            message: 'AllStats cannot be combined with StatMatches — StatMatches already defines how listed Stat lines are aggregated',
          });
        } else {
          when.statMode = 'all';
          statModeExplicit = true;
        }
        break;

      case 'statmatches': {
        if (statModeExplicit) {
          errors.push({
            line,
            text,
            message: 'StatMatches cannot be combined with AnyStat or AllStats',
          });
          break;
        }

        // C#'s Bound() accepts whole numbers only, and a stat count cannot be fractional.
        if (!/^([<>]=?|=)\s*-?\d+$/.test(remainder)) {
          errors.push({
            line,
            text,
            message: `StatMatches needs a comparison like ">= 3", got "${remainder}"`,
          });
          break;
        }

        bound(text, line, remainder, true, (min, max) => {
          if (min !== undefined) when.minStatMatches = min;
          if (max !== undefined) when.maxStatMatches = max;
        });

        statMatchesLine = line;
        statMatchesText = text;
        break;
      }

      // Backward-compatible alias. The formatter always writes the explicit spelling.
      case 'avgroll':
      case 'avgrollpct':
        // INTEGRAL, because the mod compares whole percents. `LootFilter.ItemFacts.AverageRoll`
        // rounds the mean to a whole number, so in game `AvgRollPct < 35` excludes an item averaging
        // 34.6 (it rounds to 35). The editor must make the same boundary decision as the mod.
        bound(text, line, remainder, true, (min, max) => {
          if (min !== undefined) when.minAvgRollPct = min;
          if (max !== undefined) when.maxAvgRollPct = max;
        });
        break;
      case 'toprolls':
        bound(text, line, remainder, true, (min, max) => {
          if (min !== undefined) when.minTopRolls = min;
          if (max !== undefined) when.maxTopRolls = Math.max(0, max);
        });
        break;
      case 'highrolls':
        bound(text, line, remainder, true, (min, max) => {
          if (min !== undefined) when.minHighRolls = min;
          if (max !== undefined) when.maxHighRolls = Math.max(0, max);
        });
        break;
      case 'refine':
        bound(text, line, remainder, true, (min) => {
          if (min !== undefined) when.minRefine = min;
        });
        break;
      case 'sharedstats':
        bound(text, line, remainder, true, (min) => {
          if (min !== undefined) when.minSharedStats = min;
        });
        break;
      case 'chaos': when.hasChaos = true; break;
      case 'nochaos': when.hasChaos = false; break;
      // The game's own "don't touch this" gesture, and the in-game mod's starter filter leads with it.
      case 'favorite': case 'favourite': when.favorite = true; break;
      case 'notfavorite': case 'notfavourite': when.favorite = false; break;
      // The chaos widen actually paid: a line above its normal maximum.
      case 'overroll': when.overRoll = true; break;
      case 'nooverroll': when.overRoll = false; break;
      case 'unknown': when.unknown = true; break;
      case 'known': when.unknown = false; break;
      case 'verdict': {
        const wanted = splitList(remainder).map((entry) => entry.toLowerCase());
        const bad = wanted.filter((entry) => !VERDICTS.includes(entry));
        if (bad.length) { errors.push({ line, text, message: `unknown verdict(s): ${bad.join(', ')}` }); break; }
        when.verdicts = wanted as Verdict[];
        break;
      }
      case 'color':
      case 'colour':
        if (!/^#[0-9a-f]{6}$/i.test(remainder)) { errors.push({ line, text, message: 'Color needs #rrggbb' }); break; }
        color = remainder;
        break;
      case 'tag':
        label = unquote(remainder).slice(0, 12);
        break;
      case 'highlight': {
        const wanted = remainder.toLowerCase();
        if (!LOOT_HIGHLIGHTS.includes(wanted as LootHighlight)) {
          errors.push({ line, text, message: `Highlight needs one of: ${LOOT_HIGHLIGHTS.join(', ')}` });
          break;
        }
        highlight = wanted as LootHighlight;
        break;
      }
      case 'background': {
        const wanted = remainder.toLowerCase();
        if (!LOOT_BACKGROUNDS.includes(wanted as LootBackground)) {
          errors.push({ line, text, message: `Background needs one of: ${LOOT_BACKGROUNDS.join(', ')}` });
          break;
        }
        background = wanted as LootBackground;
        break;
      }
      case 'border': {
        const wanted = remainder.toLowerCase();
        if (wanted === 'on') border = true;
        else if (wanted === 'off') border = false;
        else errors.push({ line, text, message: 'Border needs one of: on, off' });
        break;
      }
      // How `Highlight glow` was spelled before there were levels. Kept so saved filters keep parsing.
      case 'flash': highlight = 'glow'; break;
      case 'sound': {
        const name = normalizeSoundName(unquote(remainder));
        if (!name) {
          errors.push({ line, text, message: 'Sound needs a plain name like "chime" — letters, digits, dot, dash, underscore' });
          break;
        }
        sound = name;
        break;
      }
      default:
        errors.push({ line, text, message: `unknown condition "${head}"` });
    }
  }

  if (requiredStats.length) when.requiredStats = requiredStats;
  if (stats.length) when.stats = stats;
  if (anyOfStats.length) when.anyOfStats = anyOfStats;

  if (statMatchesLine !== undefined && stats.length) {
    const min = when.minStatMatches;
    const max = when.maxStatMatches;
    let message: string | undefined;

    if ((min !== undefined && min < 0) || (max !== undefined && max < 0)) {
      message = 'StatMatches cannot be negative';
    } else if (min !== undefined && max !== undefined && min > max) {
      message = `StatMatches minimum ${min} cannot exceed maximum ${max}`;
    } else if (min !== undefined && min > stats.length) {
      message = `StatMatches cannot require ${min} matches from only ${stats.length} Stat line(s)`;
    }

    if (message) {
      errors.push({ line: statMatchesLine, text: statMatchesText, message });
    }
  }

  if (statMatchesLine !== undefined && !stats.length) {
    errors.push({
      line: statMatchesLine,
      text: statMatchesText,
      message: 'StatMatches requires at least one Stat line in the same block',
    });
  }

  const rule: LootRule = {
    id: `dsl-${index + 1}`,
    name: block.name,
    enabled: true,
    color,
    ...(label ? { label } : {}),
    highlight: highlight ?? 'dot',
    background,
    border,
    ...(sound ? { sound } : {}),
    ...(block.kind === 'hide' ? { mute: true as const } : {}),
    when,
  };

  /**
   * A `Hide` block with NO conditions claims every item in the bag and says nothing about any of it —
   * the whole overlay goes dark and looks broken. It is reachable by deleting one line, so saying it
   * has to be typed out deliberately.
   */
  if (block.kind === 'hide' && !Object.keys(when).length && block.name.toLowerCase() !== 'everything') {
    errors.push({
      line: block.startLine,
      text: `Hide "${block.name}"`,
      message: 'a Hide block with no conditions silences EVERYTHING — name it "everything" if you truly mean it',
    });
  }

  // Decoration a Hide block cannot honour. Silently accepting it means an author who asked for a
  // visible treatment gets darkness and no explanation, which is the hardest filter bug to see.
  if (block.kind === 'hide' && (sound || highlight || background !== 'border' || !border)) {
    errors.push({
      line: block.startLine,
      text: `Hide "${block.name}"`,
      message: 'a Hide block draws nothing and plays nothing — remove its Highlight/Background/Border/Sound, or make it a Show block',
    });
  }

  return { rule, errors };
}

/** Render a filter back out, so the editor and the text stay interchangeable. */
export function formatLootFilter(parsed: Pick<ParsedFilter, 'rules' | 'overrides' | 'threshold'>): string {
  const out: string[] = [];
  // Before the rules, because it defines every `HighRolls` line below it. `TopRolls` is based on
  // displayed caps and is independent of this raw-roll threshold.
  if (parsed.threshold !== undefined) out.push(`Threshold ${parsed.threshold}`, '');
  /**
   * `AvgRollPct < 35` is stored just below 35 — the nudge in `parseRuleBlock` that makes `<`
   * genuinely exclusive. Rounding that to `<= 35` on output would widen the rule across its
   * boundary. A value within float noise of an integer is therefore printed back as the strict
   * comparison it came from; a value a player typed (35.5) is printed without rounding.
   */
  const bound = (value: number, inclusive: string, strict: string): string => {
    const nearest = Math.round(value);
    const drift = Math.abs(value - nearest);
    if (drift === 0) return `${inclusive} ${nearest}`;
    return drift < 1e-6 ? `${strict} ${nearest}` : `${inclusive} ${value}`;
  };
  const statBound = (stat: StatCondition): string => {
    const percent = stat.minRollPct !== undefined || stat.maxRollPct !== undefined;
    const min = percent ? stat.minRollPct : stat.minValue;
    const max = percent ? stat.maxRollPct : stat.maxValue;
    const suffix = percent ? '%' : '';
    if (min !== undefined && max !== undefined && min === max) return `= ${min}${suffix}`;
    if (min !== undefined && max === undefined) return `>= ${min}${suffix}`;
    if (max !== undefined && min === undefined) return `<= ${max}${suffix}`;
    return '>= 0';
  };
  for (const rule of parsed.rules) {
    out.push(`${rule.mute ? 'Hide' : 'Show'} "${rule.name}"`);
    const w = rule.when;
    if (w.names?.length) out.push(`    Name      ${w.names.map((n) => `"${n}"`).join(', ')}`);
    if (w.slotTypes?.length) out.push(`    Type      ${w.slotTypes.join(', ')}`);
    for (const stat of w.requiredStats ?? []) {
      out.push(`    RequireStat ${stat.stat} ${statBound(stat)}`);
    }
    for (const stat of w.stats ?? []) {
      out.push(`    Stat      ${stat.stat} ${statBound(stat)}`);
    }
    for (const group of w.anyOfStats ?? []) {
      out.push('    AnyOf');
      for (const stat of group) {
        out.push(`        Stat  ${stat.stat} ${statBound(stat)}`);
      }
    }
    const boundedStatMatches =
      w.minStatMatches !== undefined ||
      w.maxStatMatches !== undefined;

    if (boundedStatMatches) {
      if (
        w.minStatMatches !== undefined &&
        w.maxStatMatches !== undefined &&
        w.minStatMatches === w.maxStatMatches
      ) {
        out.push(`    StatMatches = ${w.minStatMatches}`);
      } else {
        if (w.minStatMatches !== undefined) {
          out.push(`    StatMatches >= ${w.minStatMatches}`);
        }

        if (w.maxStatMatches !== undefined) {
          out.push(`    StatMatches <= ${w.maxStatMatches}`);
        }
      }
    } else if (w.statMode === 'any') {
      out.push('    AnyStat');
    }
    if (w.minAvgRollPct !== undefined) out.push(`    AvgRollPct ${bound(w.minAvgRollPct, '>=', '>')}`);
    if (w.maxAvgRollPct !== undefined) out.push(`    AvgRollPct ${bound(w.maxAvgRollPct, '<=', '<')}`);
    if (w.minTopRolls !== undefined) out.push(`    TopRolls   >= ${w.minTopRolls}`);
    if (w.maxTopRolls !== undefined) out.push(`    TopRolls   <= ${w.maxTopRolls}`);
    if (w.minHighRolls !== undefined) out.push(`    HighRolls  >= ${w.minHighRolls}`);
    if (w.maxHighRolls !== undefined) out.push(`    HighRolls  <= ${w.maxHighRolls}`);
    if (w.minRefine !== undefined) out.push(`    Refine    >= ${w.minRefine}`);
    if (w.minSharedStats !== undefined) out.push(`    SharedStats >= ${w.minSharedStats}`);
    if (w.hasChaos === true) out.push('    Chaos');
    if (w.hasChaos === false) out.push('    NoChaos');
    if (w.favorite === true) out.push('    Favorite');
    if (w.favorite === false) out.push('    NotFavorite');
    if (w.overRoll === true) out.push('    OverRoll');
    if (w.overRoll === false) out.push('    NoOverRoll');
    if (w.unknown === true) out.push('    Unknown');
    if (w.verdicts?.length) out.push(`    Verdict   ${w.verdicts.join(', ')}`);
    if (rule.label) out.push(`    Tag       ${rule.label}`);
    // Only when it differs from the block's own default, which `parseRuleBlock` would supply anyway —
    // printing every colour would bury the two lines a reader is actually looking at in boilerplate.
    if (rule.color && rule.color !== (rule.mute ? '#6b7a73' : '#4ade80')) out.push(`    Color     ${rule.color}`);
    if (rule.highlight && rule.highlight !== 'dot') out.push(`    Highlight ${rule.highlight}`);
    if (rule.background && rule.background !== 'border') out.push(`    Background ${rule.background}`);
    if (rule.border === false) out.push('    Border     off');
    if (rule.sound) out.push(`    Sound     ${rule.sound}`);
    out.push('');
  }

  if (parsed.overrides.pin.length) out.push(`AlwaysShow ${parsed.overrides.pin.map((id) => `"${id}"`).join(', ')}`);
  if (parsed.overrides.mute.length) out.push(`AlwaysHide ${parsed.overrides.mute.map((id) => `"${id}"`).join(', ')}`);

  return out.join('\n');
}
