import type { AlertHistoryView, LootItemView, LootMatchView } from "../shared/contracts.ts";
import { artifactFacts, cardFacts, equipmentFacts, gemFacts } from "./catalog.ts";
import { matchLoot, type LootContext, type LootMatch } from "./filter/loot-filter.ts";
import { parseLootFilter, type ParsedFilter } from "./filter/loot-dsl.ts";
import type { OwnedGear } from "./filter/types.ts";
import type { SaviInventory, SaviSnapshot } from "./types.ts";

export interface LootSessionOptions {
  historyLimit?: number;
  soundsEnabled?: () => boolean;
  onSound?: (sound: string) => boolean | Promise<boolean>;
}

export interface SnapshotResult {
  added: LootItemView[];
  baseline: boolean;
  partial: boolean;
}

type Entry = {
  owned: OwnedGear;
  view: Omit<LootItemView, "match">;
};

export class LootSession {
  readonly #entries = new Map<string, Entry>();
  readonly #history: AlertHistoryView[] = [];
  readonly #limit: number;
  readonly #soundsEnabled: () => boolean;
  readonly #onSound: (sound: string) => boolean | Promise<boolean>;
  #baseline = false;
  #sequence = 0;
  #parsed: ParsedFilter = parseLootFilter("");

  constructor(options: LootSessionOptions = {}) {
    this.#limit = options.historyLimit ?? 200;
    this.#soundsEnabled = options.soundsEnabled ?? (() => false);
    this.#onSound = options.onSound ?? (() => false);
  }

  setFilter(text: string): ParsedFilter {
    this.#parsed = parseLootFilter(text);
    const threshold = this.#parsed.threshold ?? 90;
    for (const entry of this.#entries.values()) {
      const highRolls = entry.owned.lines.filter((line) => line.rollPct !== null && line.rollPct >= threshold).length;
      entry.owned.highRolls = highRolls;
      entry.view.highRolls = highRolls;
    }
    return this.#parsed;
  }

  get filter(): ParsedFilter {
    return this.#parsed;
  }

  resetCharacter(): void {
    this.#entries.clear();
    this.#baseline = false;
  }

  bag(): LootItemView[] {
    return [...this.#entries.values()]
      .map(({ owned, view }) => ({ ...view, match: project(matchLoot(owned, this.#parsed.rules, this.context())) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
  }

  history(): AlertHistoryView[] {
    return [...this.#history];
  }

  clearHistory(): void {
    this.#history.length = 0;
  }

  consume(snapshot: SaviSnapshot): SnapshotResult {
    const inventory = snapshot.inventory;
    if (!inventory) return { added: [], baseline: !this.#baseline, partial: true };
    return this.consumeInventory(inventory, snapshot.partial);
  }

  consumeInventory(inventory: SaviInventory, partial = false): SnapshotResult {
    const threshold = this.#parsed.threshold ?? 90;
    const next = new Map<string, Entry>();
    for (const item of inventory.equips) {
      const fact = equipmentFacts(item, threshold);
      next.set(fact.view.uid, { owned: fact, view: fact.view });
    }
    for (const item of inventory.artifacts) {
      const fact = artifactFacts(item, threshold);
      next.set(fact.view.uid, { owned: fact, view: fact.view });
    }
    for (const item of inventory.cards) {
      const fact = cardFacts(item);
      next.set(fact.view.uid, { owned: fact, view: fact.view });
    }
    for (const item of inventory.gems) {
      const fact = gemFacts(item);
      next.set(fact.view.uid, { owned: fact, view: fact.view });
    }

    const baseline = !this.#baseline;
    const added = baseline
      ? []
      : [...next]
        .filter(([uid, entry]) => entry.view.count > (this.#entries.get(uid)?.view.count ?? 0))
        .map(([, entry]) => entry);
    this.#entries.clear();
    for (const [uid, entry] of next) this.#entries.set(uid, entry);
    this.#baseline = true;

    const views = added.map(({ owned, view }) => ({
      ...view,
      match: project(matchLoot(owned, this.#parsed.rules, this.context())),
    }));
    let soundTaken = false;
    for (const view of views) {
      if (!view.match) continue;
      const soundWinner = !soundTaken && view.match.sound !== null;
      const soundResult = soundWinner && this.#soundsEnabled()
        ? this.#onSound(view.match.sound!)
        : false;
      if (soundWinner) soundTaken = true;
      const recorded = this.record(view, soundWinner, soundResult === true);
      if (typeof soundResult !== "boolean") {
        void soundResult.then(
          (played) => this.updateSoundResult(recorded, played),
          () => this.updateSoundResult(recorded, false),
        );
      }
    }
    return { added: views, baseline, partial };
  }

  private context(): LootContext {
    return { threshold: this.#parsed.threshold ?? 90 };
  }

  private record(item: LootItemView, soundWinner: boolean, soundPlayed: boolean): AlertHistoryView {
    const match = item.match!;
    const entry: AlertHistoryView = {
      sequence: ++this.#sequence,
      at: new Date().toISOString(),
      uid: item.uid,
      name: item.name,
      type: item.type,
      rule: match.rule,
      tag: match.tag,
      sound: match.sound,
      soundWinner,
      soundPlayed,
      note: soundPlayed
        ? "alert played"
        : soundWinner && match.sound
          ? "sound unavailable or disabled"
          : "matched",
    };
    this.#history.unshift(entry);
    if (this.#history.length > this.#limit) this.#history.length = this.#limit;
    return entry;
  }

  private updateSoundResult(entry: AlertHistoryView, played: boolean): void {
    entry.soundPlayed = played;
    entry.note = played ? "alert played" : "sound unavailable or disabled";
  }
}

function project(match: LootMatch | null): LootMatchView | null {
  if (!match || match.mute) return null;
  return {
    rule: match.name,
    tag: match.label,
    color: match.color,
    highlight: match.highlight,
    background: match.background,
    border: match.border,
    sound: match.sound,
  };
}
