export const DESKTOP_API_PORT = 47832;

export type CollectorPhase = "disabled" | "capture-unavailable" | "waiting-for-game" | "capturing" | "error";
export type LootKind = "equipment" | "artifact";
export type LootHighlight = "dot" | "mark" | "glow";
export type LootBackground = "border" | "fill" | "holo";

export interface CaptureDevice {
  name: string;
  description: string;
  addresses: string[];
  loopback: boolean;
}

export interface LootLine {
  stat: string;
  rollPct: number;
  printed: number | null;
  isChaos: boolean;
  over: boolean;
}

export interface LootMatchView {
  rule: string;
  tag: string;
  color: string;
  highlight: LootHighlight;
  background: LootBackground;
  border: boolean;
  sound: string | null;
}

export interface LootItemView {
  uid: string;
  itemId: string;
  name: string;
  type: string;
  kind: LootKind;
  icon: string | null;
  refine: number;
  favorite: boolean;
  hasChaos: boolean;
  topRolls: number | null;
  highRolls: number;
  avgRollPct: number | null;
  lines: LootLine[];
  match: LootMatchView | null;
}

export interface FilterErrorView {
  line: number;
  text: string;
  message: string;
}

export interface ProfileView {
  name: string;
  active: boolean;
}

export interface AlertHistoryView {
  sequence: number;
  at: string;
  uid: string;
  name: string;
  type: string;
  rule: string;
  tag: string;
  sound: string | null;
  soundWinner: boolean;
  soundPlayed: boolean;
  note: string;
}

export interface DesktopState {
  version: string;
  enabled: boolean;
  soundsEnabled: boolean;
  deviceName: string | null;
  phase: CollectorPhase;
  detail: string;
  capture: {
    backend: string;
    availability: "ready" | "missing" | "error";
    detail: string;
    version?: string;
  };
  gameDetected: boolean;
  packetsObserved: number;
  snapshotsDecoded: number;
  partialSnapshots: number;
  duplicateSnapshots: number;
  bag: LootItemView[];
  bagGeneratedAt: string | null;
  bagCoverage: string;
  filter: {
    text: string;
    path: string;
    threshold: number;
    ruleCount: number;
    errors: FilterErrorView[];
  };
  profiles: ProfileView[];
  soundsDirectory: string;
  logsDirectory: string;
  history: AlertHistoryView[];
  sounds: string[];
  warning?: string;
}

export interface DesktopSettingsUpdate {
  enabled?: boolean;
  soundsEnabled?: boolean;
  deviceName?: string | null;
}

export type ProfileCommand =
  | { action: "create"; name: string; text: string }
  | { action: "duplicate"; source: string; name: string }
  | { action: "rename"; source: string; name: string }
  | { action: "activate"; name: string };
