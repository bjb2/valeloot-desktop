import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  DESKTOP_API_PORT,
  type AlertHistoryView,
  type CaptureDevice,
  type DesktopSettingsUpdate,
  type DesktopState,
  type LinuxCaptureMode,
  type LootItemView,
  type ProfileCommand,
} from "../shared/contracts.ts";

const apiRoot = `http://127.0.0.1:${DESKTOP_API_PORT}`;
type Surface = "bag" | "filters" | "history" | "settings";

function App() {
  const [state, setState] = useState<DesktopState>();
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [surface, setSurface] = useState<Surface>("filters");
  const [connectionError, setConnectionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState("");
  const [matchesOnly, setMatchesOnly] = useState(false);
  const [selectedUid, setSelectedUid] = useState<string>();
  const [filterText, setFilterText] = useState("");
  const [filterDirty, setFilterDirty] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [history, setHistory] = useState<AlertHistoryView[]>([]);
  const [editorScroll, setEditorScroll] = useState(0);

  const loadState = useCallback(async () => {
    try {
      const response = await fetch(`${apiRoot}/v1/state`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const next = await response.json() as DesktopState;
      setState(next);
      setConnectionError(undefined);
    } catch (error) {
      setState(undefined);
      setSelectedUid(undefined);
      setConnectionError(errorMessage(error));
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetch(`${apiRoot}/v1/devices`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const value = await response.json() as { devices?: CaptureDevice[] } | CaptureDevice[];
      setDevices(Array.isArray(value) ? value : value.devices ?? []);
    } catch (error) {
      setActionError(`Network adapters could not be listed: ${errorMessage(error)}`);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(`${apiRoot}/v1/history`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const value = await response.json() as { history?: AlertHistoryView[] } | AlertHistoryView[];
      setHistory(Array.isArray(value) ? value : value.history ?? []);
    } catch (error) {
      setActionError(`Alert history could not be loaded: ${errorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => void loadState(), 2_000);
    return () => window.clearInterval(timer);
  }, [loadState]);

  useEffect(() => {
    if (!filterDirty && state) setFilterText(state.filter.text);
  }, [filterDirty, state?.filter.text]);

  useEffect(() => {
    if (state?.capture.availability === "ready") void loadDevices();
  }, [loadDevices, state?.capture.availability]);

  useEffect(() => {
    if (surface === "history") void loadHistory();
  }, [loadHistory, surface]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedUid(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    return window.valeLoot?.onAlert((name) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) return;
      const audio = new Audio(`${apiRoot}/v1/sounds/${encodeURIComponent(name)}.wav`);
      void audio.play().catch((error) => {
        setActionError(`Alert sound could not be played: ${errorMessage(error)}`);
      });
    });
  }, []);

  const selected = state?.bag.find((item) => item.uid === selectedUid);
  const filteredBag = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (state?.bag ?? []).filter((item) => {
      const searchable = [item.name, item.type, item.itemId, ...item.lines.map((line) => line.stat), item.match?.rule, item.match?.tag]
        .filter((part): part is string => Boolean(part))
        .join(" ").toLocaleLowerCase();
      return (!matchesOnly || item.match !== null) && (!needle || searchable.includes(needle));
    });
  }, [matchesOnly, query, state?.bag]);

  const invoke = async (label: string, request: () => Promise<Response>) => {
    setBusy(label);
    setActionError(undefined);
    try {
      const response = await request();
      if (!response.ok) throw new Error(await responseError(response));
      await loadState();
    } catch (error) {
      setActionError(`${label}: ${errorMessage(error)}`);
    } finally {
      setBusy(undefined);
    }
  };

  const updateSettings = (update: DesktopSettingsUpdate) => invoke("Settings were not saved", () => fetch(`${apiRoot}/v1/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  }));

  const saveFilter = () => invoke("Filter was not saved", async () => {
    const response = await fetch(`${apiRoot}/v1/filter`, {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: filterText,
    });
    if (response.ok) setFilterDirty(false);
    return response;
  });

  const profile = (command: ProfileCommand) => invoke("Profile change failed", async () => {
    const response = await fetch(`${apiRoot}/v1/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (response.ok && command.action !== "activate") setProfileName("");
    return response;
  });

  const clearHistory = () => invoke("History could not be cleared", async () => {
    const response = await fetch(`${apiRoot}/v1/history`, { method: "DELETE" });
    if (response.ok) setHistory([]);
    return response;
  });


  const lineNumbers = filterText.split("\n");

  return (
    <div class="app-shell">
      <aside class="rail">
        <header class="brand-block">
          <div class="brand-mark" aria-hidden="true">V</div>
          <div><div class="brand">ValeLoot</div><div class="brand-subtitle">Filter</div></div>
        </header>

        <nav class="rail-nav" aria-label="Workspace sections">
          <NavButton current={surface} value="filters" label="Text" detail={state ? String(state.filter.errors.length) : ""} onSelect={setSurface} />
          <NavButton current={surface} value="bag" label="Bag" detail={String(state?.bag.length ?? 0)} onSelect={setSurface} />
          <NavButton current={surface} value="history" label="History" detail={String(history.length || state?.history.length || 0)} onSelect={setSurface} />
          <NavButton current={surface} value="settings" label="Settings" detail="" onSelect={setSurface} />
        </nav>

        <section class="capture-status" aria-labelledby="capture-title">
          <div class="section-kicker" id="capture-title">Passive capture</div>
          <div class="capture-copy">
            <span class={`state-light ${state?.phase ?? "offline"}`} aria-hidden="true" />
            <div><strong>{state?.detail ?? "Connecting to local collector"}</strong><span>{phaseCaption(state)}</span></div>
          </div>
          <p class="privacy-note">Reads local inventory traffic only. No game injection, memory access, packet writing, upload, or raw packet storage.</p>
        </section>
        <footer class="rail-foot"><span>Local only</span><span>{state ? `v${state.version}` : "Starting"}</span></footer>
      </aside>

      <main class="workspace">
        {actionError && <div class="notice error" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError(undefined)} aria-label="Dismiss error">×</button></div>}
        {state?.warning && <div class="notice warning" role="status">{state.warning}</div>}
        {surface === "bag" && <BagSurface state={state} error={connectionError} query={query} matchesOnly={matchesOnly} items={filteredBag} selected={selected} busy={busy} onQuery={setQuery} onMatchesOnly={setMatchesOnly} onSelect={setSelectedUid} onRetry={() => void loadState()} onClose={() => setSelectedUid(undefined)} />}
        {surface === "filters" && <FiltersSurface state={state} text={filterText} dirty={filterDirty} scroll={editorScroll} lineNumbers={lineNumbers} profileName={profileName} selected={selected} busy={busy} onText={(value) => { setFilterText(value); setFilterDirty(true); }} onScroll={setEditorScroll} onSave={() => void saveFilter()} onProfileName={setProfileName} onProfile={profile} onSelect={setSelectedUid} onClose={() => setSelectedUid(undefined)} />}
        {surface === "history" && <HistorySurface history={history} loading={!state && !connectionError} busy={busy} onClear={() => void clearHistory()} onReload={() => void loadHistory()} />}
        {surface === "settings" && <SettingsSurface state={state} devices={devices} busy={busy} onUpdate={updateSettings} onRestart={() => void invoke("Capture restart failed", () => fetch(`${apiRoot}/v1/capture/restart`, { method: "POST" }))} />}
      </main>
    </div>
  );
}

function NavButton({ current, value, label, detail, onSelect }: { current: Surface; value: Surface; label: string; detail: string; onSelect(value: Surface): void }) {
  return <button class={`nav-item ${current === value ? "active" : ""}`} type="button" aria-current={current === value ? "page" : undefined} onClick={() => onSelect(value)}><span>{label}</span>{detail && <small>{detail}</small>}</button>;
}

function BagSurface({ state, error, query, matchesOnly, items, selected, busy, onQuery, onMatchesOnly, onSelect, onRetry, onClose }: {
  state: DesktopState | undefined; error: string | undefined; query: string; matchesOnly: boolean; items: LootItemView[]; selected: LootItemView | undefined; busy: string | undefined; onQuery(value: string): void; onMatchesOnly(value: boolean): void; onSelect(uid: string): void; onRetry(): void; onClose(): void;
}) {
  const heading = state?.phase === "capturing" ? "Live bag" : "Bag ledger";
  return <>
    <SurfaceHeader eyebrow="Inventory · passive observation" title={heading} freshness={state?.bagGeneratedAt ? `Snapshot ${relativeTime(state.bagGeneratedAt)}` : state ? state.bagCoverage : "Local collector"} live={state?.phase === "capturing"} />
    <div class="ledger-tools">
      <label class="search-field"><span class="visually-hidden">Search bag</span><span aria-hidden="true">⌕</span><input type="search" value={query} placeholder="Search item, trait, rule, or tag" onInput={(event) => onQuery(event.currentTarget.value)} />{query && <button type="button" onClick={() => onQuery("")} aria-label="Clear bag search">×</button>}</label>
      <div class="segmented" aria-label="Bag scope"><button class={!matchesOnly ? "selected" : ""} type="button" aria-pressed={!matchesOnly} onClick={() => onMatchesOnly(false)}>All <span>{state?.bag.length ?? 0}</span></button><button class={matchesOnly ? "selected" : ""} type="button" aria-pressed={matchesOnly} onClick={() => onMatchesOnly(true)}>Matches <span>{state?.bag.filter((item) => item.match).length ?? 0}</span></button></div>
      <span class="coverage">{state?.bagCoverage ?? "Waiting for a local snapshot"}</span>
    </div>
    <section class="ledger" aria-label="Observed bag" aria-live="polite">
      <div class="ledger-head"><span>Item</span><span>Notable rolls</span><span>Rule</span><span>Rolls</span></div>
      {error && !state ? <Empty title="Collector unavailable" detail={`ValeLoot could not reach its local service. ${error}`} action="Reconnect" onAction={onRetry} />
        : !state ? <Empty title="Connecting to collector" detail="Waiting for the local capture service to report its inventory state." />
        : state.phase === "capture-unavailable" ? <Empty title={`${state.capture.backend} is needed to observe the bag`} detail={`Open Settings to review the ${state.capture.backend} status, then install or repair the capture backend before restarting capture.`} />
        : state.phase === "disabled" ? <Empty title="Capture is paused" detail="Enable passive capture in Settings to watch the next bag snapshot." />
        : state.bag.length === 0 ? <Empty title="No items observed yet" detail={state.phase === "waiting-for-game" ? "Launch Spirit Vale and enter a character. The first complete bag snapshot is silent." : "Keep the game open and change inventory to let ValeLoot observe a complete bag snapshot."} />
        : items.length === 0 ? <Empty title="No items match this view" detail={matchesOnly ? "No current item matches your active filter. Switch to All to inspect the bag." : "Try a shorter search term or clear the search."} action={matchesOnly && !query ? "Show all" : "Clear search"} onAction={() => { if (matchesOnly && !query) onMatchesOnly(false); else onQuery(""); }} />
        : <div class="ledger-body">{items.map((item) => <ItemRow key={item.uid} item={item} selected={selected?.uid === item.uid} onSelect={onSelect} />)}</div>}
    </section>
    {selected && <ItemInspector item={selected} onClose={onClose} />}
    {busy && <div class="busy-note" role="status">{busy}</div>}
  </>;
}

function SurfaceHeader({ eyebrow, title, freshness, live = false, children }: { eyebrow: string; title: string; freshness: string; live?: boolean; children?: JSX.Element }) {
  return <header class="surface-header"><div><div class="eyebrow">{eyebrow}</div><h1>{title}</h1></div><div class="header-detail"><span class={`capture-pulse ${live ? "live" : ""}`} aria-hidden="true" /><span>{freshness}</span>{children}</div></header>;
}

function ItemRow({ item, selected, onSelect }: { item: LootItemView; selected: boolean; onSelect(uid: string): void }) {
  const bestLines = item.lines.filter((line) => line.over || line.rollPct >= 90).slice(0, 2);
  const style = item.match ? { "--rule-color": item.match.color } as JSX.CSSProperties : undefined;
  const treatment = item.match ? `matched highlight-${item.match.highlight} background-${item.match.background} ${item.match.border ? "" : "border-off"}` : "";
  return <button class={`item-row ${selected ? "selected" : ""} ${treatment}`} style={style} type="button" onClick={() => onSelect(item.uid)}>
    <span class="item-cell">{item.icon ? <img class="item-icon" src={iconUrl(item.icon)} alt="" loading="lazy" decoding="async" /> : <span class={`item-sigil ${item.kind}`}>{item.kind === "artifact" ? "A" : "E"}</span>}<span><strong>{item.name || item.itemId}</strong><small>{item.type} · {item.refine > 0 ? `+${item.refine}` : item.itemId}{item.favorite ? " · favorited" : ""}</small></span></span>
    <span class="roll-summary">{bestLines.length ? bestLines.map((line) => <span key={line.stat}>{line.stat} <b>{formatPct(line.rollPct)}</b></span>) : <em>{item.hasChaos ? "Chaos item" : "No high roll"}</em>}</span>
    <span class="rule-cell">{item.match ? <><i /><span>{item.match.tag || item.match.rule}</span></> : <em>—</em>}</span>
    <span class="roll-count">{item.topRolls ? `${item.topRolls} top` : ""}{item.highRolls ? `${item.highRolls} high` : ""}<small>{item.avgRollPct === null ? "—" : formatPct(item.avgRollPct)}</small></span>
  </button>;
}

function ItemInspector({ item, onClose }: { item: LootItemView; onClose(): void }) {
  return <aside class="inspector" aria-label="Selected item" style={item.match ? { "--rule-color": item.match.color } as JSX.CSSProperties : undefined}>
    <header>{item.icon && <img class="inspector-icon" src={iconUrl(item.icon)} alt="" />}<div><div class="eyebrow">{item.kind} · {item.itemId}</div><h2>{item.name || item.itemId}</h2><p>{item.type}{item.refine > 0 ? ` · Refine +${item.refine}` : ""}</p></div><button type="button" class="close-button" onClick={onClose} aria-label="Close item inspector">×</button></header>
    <section class="inspector-summary"><div><small>Average roll</small><strong>{item.avgRollPct === null ? "—" : formatPct(item.avgRollPct)}</strong></div><div><small>High rolls</small><strong>{item.highRolls}</strong></div><div><small>Chaos</small><strong>{item.hasChaos ? "Yes" : "No"}</strong></div></section>
    <section class="inspector-section"><div class="section-kicker">Observed stats</div><dl class="stat-list">{item.lines.length ? item.lines.map((line) => <div key={`${line.stat}:${line.printed ?? ""}`} class={line.over ? "over" : ""}><dt>{line.stat}{line.isChaos && <span> Chaos</span>}</dt><dd>{line.printed === null ? "—" : line.printed}<b>{formatPct(line.rollPct)}</b></dd></div>) : <p class="muted">No stat lines were decoded for this item.</p>}</dl></section>
    <section class="inspector-section"><div class="section-kicker">Filter result</div>{item.match ? <div class="match-detail"><span class="match-swatch" /><strong>{item.match.rule}</strong><p><b>{item.match.tag || "Untagged"}</b> · {item.match.highlight} {item.match.background}{item.match.border ? " border" : ""}{item.match.sound ? ` · ${item.match.sound} sound` : " · no sound"}</p></div> : <p class="muted">This item does not match an active rule.</p>}</section>
    <section class="inspector-section item-meta"><div><span>UID</span><code>{item.uid}</code></div><div><span>Favorite</span><b>{item.favorite ? "Yes" : "No"}</b></div></section>
  </aside>;
}

function FiltersSurface({ state, text, dirty, scroll, lineNumbers, profileName, selected, busy, onText, onScroll, onSave, onProfileName, onProfile, onSelect, onClose }: {
  state: DesktopState | undefined; text: string; dirty: boolean; scroll: number; lineNumbers: string[]; profileName: string; selected: LootItemView | undefined; busy: string | undefined; onText(value: string): void; onScroll(value: number): void; onSave(): void; onProfileName(value: string): void; onProfile(command: ProfileCommand): void; onSelect(uid: string): void; onClose(): void;
}) {
  const active = state?.profiles.find((profile) => profile.active);
  const activeName = active?.name ?? "";
  const validName = profileName.trim();
  const matched = state?.bag.filter((item) => item.match).length ?? 0;
  const ruleCount = state?.filter.ruleCount ?? 0;
  return <>
    <SurfaceHeader eyebrow="ValeLoot · filter" title="Text" freshness={state ? `${ruleCount} active rule${ruleCount === 1 ? "" : "s"} · ${state.filter.errors.length ? `${state.filter.errors.length} parse issue${state.filter.errors.length === 1 ? "" : "s"}` : `${state.profiles.length} profile${state.profiles.length === 1 ? "" : "s"}`} · ${state.bag.length} items` : "Waiting for filter state"} />
    <div class="filter-layout">
      <section class="rule-editor-section" aria-labelledby="rule-text-title">
        <div class="section-heading"><div><div class="section-kicker">Rules · text</div><h2 id="rule-text-title">{active?.name ?? "Default rules"}{dirty && <span class="dirty-mark">Unsaved</span>}</h2></div><button class="primary-action" type="button" disabled={!state || !dirty || busy !== undefined} onClick={onSave}>{busy === "Filter was not saved" ? "Saving…" : "Save to the game"}</button></div>
        <div class="editor-frame"><div class="line-numbers" aria-hidden="true" style={{ transform: `translateY(-${scroll}px)` }}>{lineNumbers.map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea aria-label="Filter rule text" spellcheck={false} value={text} onInput={(event) => onText(event.currentTarget.value)} onScroll={(event) => onScroll(event.currentTarget.scrollTop)} /></div>
        <p class="editor-note">{state && ruleCount === 0 ? "No rules are active. Roll percentages are item data and do not paint or match an item." : "Every active rule is shown above. Save to parse the text and repaint the observed bag."}</p>
      </section>
      <section class="filter-bag-preview" aria-label="Bag as painted by the filter">
        <div class="preview-head"><div class="section-kicker">{ruleCount === 0 ? "Inventory preview · no rules active" : "Your bag, as the filter paints it"}</div><div class="preview-tally"><span><b>{matched}</b> rule match{matched === 1 ? "" : "es"}</span><span><b>{Math.max(0, (state?.bag.length ?? 0) - matched)}</b> unmatched</span><span><b>{state?.bag.length ?? 0}</b> seen this session</span></div></div>
        {!state || state.bag.length === 0
          ? <Empty title="Waiting for the bag" detail="Launch Spirit Vale and enter a character. The first complete inventory snapshot becomes the silent baseline." />
          : <div class="preview-grid">{state.bag.map((item) => <ItemRow key={item.uid} item={item} selected={selected?.uid === item.uid} onSelect={onSelect} />)}</div>}
      </section>
      <aside class="filter-side">
        <section class="side-section"><div class="section-kicker">High-roll threshold</div><output class="threshold-value">{state ? `${state.filter.threshold}%` : "—"}</output><p>Defines the HighRolls item metric. It never highlights an item without a matching Show rule.</p></section>
        <section class="side-section parse-section" aria-live="polite"><div class="section-kicker">Parser</div>{!state ? <p>Waiting for the local filter state.</p> : state.filter.errors.length ? <ul class="parse-errors">{state.filter.errors.map((error) => <li key={`${error.line}:${error.message}`}><b>Line {error.line}</b><code>{error.text}</code><span>{error.message}</span></li>)}</ul> : ruleCount === 0 ? <p class="parse-ok">No rules are active. The preview remains unpainted.</p> : <p class="parse-ok">{ruleCount} active rule{ruleCount === 1 ? "" : "s"}. Every applied rule is visible in the editor.</p>}</section>
        <section class="side-section"><div class="section-kicker">Profiles</div><div class="profile-list">{state?.profiles.map((entry) => <button key={entry.name} type="button" class={entry.active ? "active-profile" : ""} aria-pressed={entry.active} disabled={busy !== undefined || entry.active || dirty} title={dirty && !entry.active ? "Save or discard the current edits before switching profiles" : undefined} onClick={() => onProfile({ action: "activate", name: entry.name })}><span>{entry.name}</span>{entry.active && <small>Active</small>}</button>)}</div><label class="profile-field"><span>New profile name</span><input value={profileName} placeholder="Profile name" onInput={(event) => onProfileName(event.currentTarget.value)} /></label><div class="profile-actions"><button type="button" disabled={!validName || busy !== undefined} onClick={() => onProfile({ action: "create", name: validName, text })}>Create</button><button type="button" disabled={!validName || !activeName || busy !== undefined} onClick={() => onProfile({ action: "duplicate", name: validName, source: activeName })}>Duplicate</button><button type="button" disabled={!validName || !activeName || busy !== undefined} onClick={() => onProfile({ action: "rename", name: validName, source: activeName })}>Rename</button></div></section>
      </aside>
    </div>
    {selected && <ItemInspector item={selected} onClose={onClose} />}
  </>;
}

function HistorySurface({ history, loading, busy, onClear, onReload }: { history: AlertHistoryView[]; loading: boolean; busy: string | undefined; onClear(): void; onReload(): void }) {
  return <>
    <SurfaceHeader eyebrow="Alerts · local session log" title="History" freshness={`${history.length} recorded alert${history.length === 1 ? "" : "s"}`}><button class="quiet-action" type="button" onClick={onReload}>Reload</button></SurfaceHeader>
    <section class="history-ledger" aria-label="Local alert history"><div class="history-head"><span>When</span><span>Item</span><span>Rule</span><span>Sound outcome</span></div>{loading ? <Empty title="Loading local alert history" detail="Reading the current local session record." /> : history.length === 0 ? <Empty title="No alerts recorded" detail="Matched items appear here after a complete bag snapshot adds their UID. Initial snapshots stay silent." /> : <div class="history-body">{history.map((entry) => <article class="history-row" key={entry.sequence}><time dateTime={entry.at}>{relativeTime(entry.at)}</time><div><strong>{entry.name}</strong><small>{entry.type} · {entry.uid}</small></div><div><b>{entry.tag || entry.rule}</b><small>{entry.note}</small></div><div class={`sound-outcome ${entry.soundPlayed ? "played" : ""}`}><strong>{entry.soundPlayed ? `${entry.sound ?? "Alert"} played` : entry.soundWinner ? "Sound suppressed" : "No sound"}</strong><small>{entry.soundWinner ? "Winning matched rule" : "Non-winning match"}</small></div></article>)}</div>}</section>
    <footer class="surface-footer"><span>History is kept for this app session and can be cleared at any time.</span><button class="danger-action" type="button" disabled={history.length === 0 || busy !== undefined} onClick={onClear}>{busy === "History could not be cleared" ? "Clearing…" : "Clear history"}</button></footer>
  </>;
}

function SettingsSurface({ state, devices, busy, onUpdate, onRestart }: { state: DesktopState | undefined; devices: CaptureDevice[]; busy: string | undefined; onUpdate(update: DesktopSettingsUpdate): void; onRestart(): void }) {
  const isLinux = state ? (state.capture.backend === "libpcap" || state.capture.backend === "libpcap (direct)" || state.capture.backend === "dumpcap") : false;
  return <>
    <SurfaceHeader eyebrow="Collector · local configuration" title="Settings" freshness={state ? state.capture.detail : "Waiting for local collector"} />
    <div class="settings-layout">
      <section class="settings-section"><div class="section-heading"><div><div class="section-kicker">Capture controls</div><h2>Passive observation</h2></div><button class="primary-action" type="button" disabled={!state || busy !== undefined} onClick={onRestart}>{busy === "Capture restart failed" ? "Restarting…" : "Restart capture"}</button></div><label class="switch-row"><span><strong>Enable capture</strong><small>Observe inventory packets on the selected local adapter.</small></span><input type="checkbox" role="switch" checked={state?.enabled ?? false} disabled={!state || busy !== undefined} onChange={(event) => onUpdate({ enabled: event.currentTarget.checked })} /></label><label class="switch-row"><span><strong>Play local alerts</strong><small>Play a matched rule's selected sound once per new item UID.</small></span><input type="checkbox" role="switch" checked={state?.soundsEnabled ?? false} disabled={!state || busy !== undefined} onChange={(event) => onUpdate({ soundsEnabled: event.currentTarget.checked })} /></label><label class="device-field"><span>Network adapter</span><select value={state?.deviceName ?? ""} disabled={!state || busy !== undefined || state.capture.availability !== "ready"} onChange={(event) => onUpdate({ deviceName: event.currentTarget.value || null })}><option value="">Automatic selection</option>{devices.filter((device) => !device.loopback).map((device) => <option key={device.name} value={device.name}>{device.description || device.name}{device.addresses.length ? ` · ${device.addresses.join(", ")}` : ""}</option>)}</select><small>{state?.capture.availability === "ready" ? "Choose Automatic to let the collector select an active adapter." : `Adapter selection is available after ${state?.capture.backend ?? "packet capture"} is ready.`}</small></label>{isLinux && <label class="device-field"><span>Capture method</span><select value={state?.linuxCaptureMode ?? "auto"} disabled={!state || busy !== undefined} onChange={(event) => onUpdate({ linuxCaptureMode: event.currentTarget.value as LinuxCaptureMode })}><option value="auto">Automatic (prefer dumpcap)</option><option value="dumpcap">dumpcap only</option><option value="libpcap">Direct libpcap</option></select><small>{captureMethodDescription(state?.linuxCaptureMode)}</small></label>}</section>
      <aside class="settings-side"><section class="side-section capture-backend-state"><div class="section-kicker">{state?.capture.backend ?? "Packet capture"}</div><strong>{captureAvailabilityLabel(state?.capture.availability)}</strong>{state?.capture.version && <code>Version {state.capture.version}</code>}<p>{state?.capture.detail ?? "Checking packet capture availability."}</p></section><section class="side-section"><div class="section-kicker">Diagnostic logs</div><p>Verbose desktop, collector, capture, connection, warning, and shutdown events are written locally for troubleshooting.</p><code class="sound-path">{state?.logsDirectory ?? "Loading log folder…"}</code></section><section class="side-section"><div class="section-kicker">Available sounds</div><p>Drop <code>.wav</code> files into this folder. They are detected automatically; use <code>Sound filename</code> with or without the extension.</p><code class="sound-path">{state?.soundsDirectory ?? "Loading sounds folder…"}</code><p><b>{(state?.sounds ?? []).join(", ") || "Loading…"}</b></p></section><section class="side-section privacy-disclosure"><div class="section-kicker">Privacy boundary</div><p>Capture is local and passive. ValeLoot reads only traffic owned by <code>SpiritVale.exe</code>; no packet contents, filters, settings, alert history, or diagnostic logs are uploaded.</p></section></aside>
    </div>
  </>;
}

function captureMethodDescription(mode?: LinuxCaptureMode): string {
  if (mode === "dumpcap") return "Always use the privileged dumpcap helper. Requires Wireshark or a standalone dumpcap binary.";
  if (mode === "libpcap") return "Bypass dumpcap and use libpcap directly. Requires CAP_NET_RAW and CAP_NET_ADMIN on the collector process.";
  return "Use dumpcap when available; fall back to direct libpcap. Changing this restarts capture.";
}

function Empty({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div class="empty-state"><span class="empty-rune" aria-hidden="true">◇</span><h2>{title}</h2><p>{detail}</p>{action && onAction && <button type="button" onClick={onAction}>{action}</button>}</div>;
}

function phaseCaption(state?: DesktopState): string {
  if (!state) return "The desktop service has not responded yet.";
  switch (state.phase) {
    case "capturing": return `${state.packetsObserved.toLocaleString()} packets observed · ${state.snapshotsDecoded.toLocaleString()} snapshots decoded`;
    case "waiting-for-game": return "Waiting for a Spirit Vale connection.";
    case "capture-unavailable": return `${state.capture.backend} is unavailable. Review Settings.`;
    case "disabled": return "Capture is disabled in local settings.";
    case "error": return "The collector reported an error. Review Settings.";
  }
}

function captureAvailabilityLabel(availability?: DesktopState["capture"]["availability"]): string {
  return availability === "ready" ? "Ready" : availability === "missing" ? "Not installed" : availability === "error" ? "Unavailable" : "Checking";
}

function iconUrl(name: string): string { return `${apiRoot}/v1/icons/${encodeURIComponent(name)}`; }
function formatPct(value: number): string { return `${Math.round(value)}%`; }
function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status} ${response.statusText}`;
  try {
    const value = JSON.parse(text) as { error?: unknown };
    if (typeof value.error === "string") return value.error;
  } catch {}
  return text;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

render(<App />, document.getElementById("app")!);
