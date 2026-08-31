import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CaptureConnectionEvent, CaptureTargetStatus } from "@kar-mi/spirit-vale-tools-capture";
import { getNpcapStatus, listNpcapDevices, PacketCapture } from "@kar-mi/spirit-vale-tools-capture/capture";
import type { NpcapStatus } from "@kar-mi/spirit-vale-tools-capture/capture";
import type { DesktopSettingsUpdate, DesktopState, ProfileCommand } from "../shared/contracts.ts";
import { DESKTOP_API_PORT } from "../shared/contracts.ts";
import { LootSession } from "../core/loot-session.ts";
import { parseLootFilter } from "../core/filter/loot-dsl.ts";
import { consumeFishNetPacket } from "../core/packet-consumer.ts";
import { FishNetCaptureDecoder } from "./fishnet-capture-decoder.ts";
import { NeutralinoClient } from "./neutralino-client.ts";
import { canonicalSoundName, findCustomSound, listCustomSounds, SOUND_NAMES, SOUND_WAVS } from "./sounds.ts";

type Persisted = {
  enabled: boolean;
  soundsEnabled: boolean;
  deviceName: string | null;
  filter: string;
  active: string;
  profiles: Record<string, string>;
};

const root = path.resolve(import.meta.dir, "../..");
const portable = existsSync(path.join(root, ".valeloot-portable"));
const dataDirectory = portable
  ? path.join(root, "data")
  : path.join(process.env.LOCALAPPDATA ?? root, "ValeLoot Desktop");
const settingsPath = path.join(dataDirectory, "settings.json");
const soundsDirectory = path.join(dataDirectory, "sounds");
const iconDirectory = existsSync(path.join(import.meta.dir, "icons"))
  ? path.join(import.meta.dir, "icons")
  : path.join(root, "assets", "icons");
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
mkdirSync(soundsDirectory, { recursive: true });

function defaultSettings(): Persisted {
  return {
    enabled: true,
    soundsEnabled: true,
    deviceName: null,
    filter: "",
    active: "Default",
    profiles: { Default: "" },
  };
}

function loadSettings(): Persisted {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const profiles: Record<string, string> = {};
    if (raw.profiles && typeof raw.profiles === "object") {
      for (const [name, text] of Object.entries(raw.profiles)) {
        if (profileNamePattern.test(name) && typeof text === "string") profiles[name] = text;
      }
    }
    if (Object.keys(profiles).length === 0) profiles.Default = "";
    const requestedActive = typeof raw.active === "string" ? raw.active : "Default";
    const active = Object.hasOwn(profiles, requestedActive) ? requestedActive : Object.keys(profiles)[0]!;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      soundsEnabled: typeof raw.soundsEnabled === "boolean" ? raw.soundsEnabled : true,
      deviceName: raw.deviceName === null || typeof raw.deviceName === "string" ? raw.deviceName : null,
      filter: profiles[active]!,
      active,
      profiles,
    };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(value: Persisted): void {
  mkdirSync(dataDirectory, { recursive: true });
  const temporary = `${settingsPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, settingsPath);
}

let persisted = loadSettings();
let nativeClient: NeutralinoClient | undefined;
const session = new LootSession({
  soundsEnabled: () => persisted.soundsEnabled,
  onSound: async (sound) => {
    const requested = canonicalSoundName(sound);
    const builtin = requested?.toLowerCase();
    const custom = builtin && !Object.hasOwn(SOUND_WAVS, builtin) ? findCustomSound(soundsDirectory, builtin) : null;
    const name = builtin && Object.hasOwn(SOUND_WAVS, builtin) ? builtin : custom?.name;
    if (!nativeClient || !name) return false;
    try {
      await nativeClient.call("app.broadcast", {
        event: "valeLootPlaySound",
        data: { name },
      });
      return true;
    } catch (error) {
      warning = `Could not dispatch alert sound: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  },
});
session.setFilter(persisted.filter);

let npcap: NpcapStatus = { availability: "missing", detail: "Checking Npcap" };
let capture: PacketCapture | undefined;
let phase: DesktopState["phase"] = "disabled";
let detail = "Capture disabled";
let warning: string | undefined;
let gameDetected = false;
let activeConnectionId: string | undefined;
let packetsObserved = 0;
let snapshotsDecoded = 0;
let partialSnapshots = 0;
let duplicateSnapshots = 0;
let bagGeneratedAt: string | null = null;
let bagCoverage = "No inventory snapshot yet";
const fishNetDecoder = new FishNetCaptureDecoder({
  onPacket: (packet) => {
    packetsObserved++;
    const result = consumeFishNetPacket(packet);
    if (!result.snapshot) return;
    snapshotsDecoded++;
    if (result.snapshot.partial) partialSnapshots++;
    session.consume(result.snapshot);
    bagGeneratedAt = new Date().toISOString();
    bagCoverage = result.snapshot.partial
      ? "Partial snapshot merged with last complete bag"
      : "Complete inventory snapshot";
  },
  onWarning: (message) => { warning = message; },
});

async function restartCapture(): Promise<void> {
  await capture?.stop().catch(() => undefined);
  fishNetDecoder.reset();
  capture = undefined;
  gameDetected = false;
  activeConnectionId = undefined;
  warning = undefined;

  if (!persisted.enabled) {
    phase = "disabled";
    detail = "Capture disabled";
    return;
  }

  try {
    npcap = await getNpcapStatus();
  } catch (error) {
    npcap = {
      availability: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (npcap.availability !== "ready") {
    phase = "npcap-unavailable";
    detail = npcap.detail;
    return;
  }

  try {
    const nextCapture = new PacketCapture();
    nextCapture.on("targetStatus", (status: CaptureTargetStatus) => {
      gameDetected = status.state === "active";
      phase = gameDetected ? "capturing" : "waiting-for-game";
      detail = gameDetected ? "Spirit Vale detected" : "Waiting for Spirit Vale";
      if (!gameDetected) activeConnectionId = undefined;
    });
    nextCapture.on("connection", (event: CaptureConnectionEvent) => {
      if (event.state === "opened") {
        if (activeConnectionId !== event.connectionId) session.resetCharacter();
        activeConnectionId = event.connectionId;
        detail = "Spirit Vale connection observed";
      } else if (activeConnectionId === event.connectionId) {
        activeConnectionId = undefined;
        detail = gameDetected ? "Waiting for Spirit Vale to reconnect" : "Waiting for Spirit Vale";
      }
    });
    nextCapture.on("liteNetPacket", (packet) => fishNetDecoder.consume(packet));
    nextCapture.on("warning", (message: string) => {
      warning = message;
      const duplicateMatch = /(?:suppressed|ignored)\s+(\d+)\s+duplicate/i.exec(message);
      if (duplicateMatch?.[1]) duplicateSnapshots += Number.parseInt(duplicateMatch[1], 10);
    });
    nextCapture.on("error", (error: Error) => {
      phase = "error";
      detail = error.message;
    });
    await nextCapture.start({
      protocols: ["udp"],
      targetProcessName: "SpiritVale.exe",
      decodeLiteNetLib: true,
      ...(persisted.deviceName ? { deviceName: persisted.deviceName } : {}),
    });
    capture = nextCapture;
    phase = gameDetected ? "capturing" : "waiting-for-game";
    detail = gameDetected ? "Spirit Vale detected" : "Waiting for Spirit Vale";
  } catch (error) {
    phase = "error";
    detail = error instanceof Error ? error.message : String(error);
  }
}

function currentState(): DesktopState {
  const stateWarning = warning;
  return {
    version: "0.1.0",
    enabled: persisted.enabled,
    soundsEnabled: persisted.soundsEnabled,
    deviceName: persisted.deviceName,
    phase,
    detail,
    npcap,
    gameDetected,
    packetsObserved,
    snapshotsDecoded,
    partialSnapshots,
    duplicateSnapshots,
    bag: session.bag(),
    bagGeneratedAt,
    bagCoverage,
    filter: {
      text: persisted.filter,
      path: `profiles/${persisted.active}.filter`,
      threshold: session.filter.threshold ?? 90,
      ruleCount: session.filter.rules.length,
      errors: session.filter.errors,
    },
    profiles: Object.keys(persisted.profiles)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, active: name === persisted.active })),
    history: session.history(),
    sounds: [...SOUND_NAMES, ...listCustomSounds(soundsDirectory).map((sound) => sound.name)],
    soundsDirectory,
    ...(stateWarning ? { warning: stateWarning } : {}),
  };
}

function errorResponse(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

function invalidFilterResponse(filter: string): Response | null {
  const parsed = parseLootFilter(filter);
  if (!parsed.errors.length) return null;
  const summary = parsed.errors
    .slice(0, 3)
    .map((error) => `line ${error.line}: ${error.message}`)
    .join("; ");
  return errorResponse(`filter has ${parsed.errors.length} parse error${parsed.errors.length === 1 ? "" : "s"}: ${summary}`, 422);
}

async function readText(request: Request, limit: number): Promise<string | null> {
  const body = await request.text();
  return body.length <= limit ? body : null;
}

function normalizedProfileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return profileNamePattern.test(name) ? name : null;
}

async function routeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const route = url.pathname;

  if (method === "GET" && route === "/v1/state") return Response.json(currentState());
  if (method === "GET" && route === "/v1/devices") {
    if (npcap.availability !== "ready") return Response.json([]);
    return Response.json(await listNpcapDevices().catch(() => []));
  }
  if (method === "GET" && route === "/v1/history") return Response.json(session.history());
  if (method === "DELETE" && route === "/v1/history") {
    session.clearHistory();
    return new Response(null, { status: 204 });
  }
  if (method === "GET" && route === "/v1/profiles") {
    return Response.json({
      active: persisted.active,
      profiles: Object.entries(persisted.profiles).map(([name, text]) => ({ name, text })),
    });
  }
  if (method === "GET" && route.startsWith("/v1/sounds/")) {
    const requested = canonicalSoundName(decodeURIComponent(route.slice("/v1/sounds/".length)));
    if (!requested) return errorResponse("unknown sound", 404);
    const builtin = requested.toLowerCase();
    const bytes = SOUND_WAVS[builtin];
    if (bytes) {
      return new Response(new Blob([bytes.slice().buffer as ArrayBuffer]), {
        headers: { "cache-control": "public, max-age=86400, immutable", "content-type": "audio/wav" },
      });
    }
    const custom = findCustomSound(soundsDirectory, requested);
    if (!custom) return errorResponse("unknown sound", 404);
    return new Response(Bun.file(custom.path), {
      headers: { "cache-control": "no-cache", "content-type": "audio/wav" },
    });
  }
  if (method === "GET" && route.startsWith("/v1/icons/")) {
    const name = decodeURIComponent(route.slice("/v1/icons/".length));
    if (!/^[A-Za-z0-9_.-]+\.webp$/.test(name)) return errorResponse("unknown icon", 404);
    const file = path.join(iconDirectory, name);
    if (!existsSync(file)) return errorResponse("unknown icon", 404);
    return new Response(Bun.file(file), {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": "image/webp",
      },
    });
  }
  if (method === "PUT" && route === "/v1/settings") {
    const raw = await readText(request, 8_192);
    if (raw === null) return errorResponse("settings payload is too large", 413);
    let update: DesktopSettingsUpdate;
    try {
      update = JSON.parse(raw) as DesktopSettingsUpdate;
    } catch {
      return errorResponse("invalid JSON");
    }
    if ((update.enabled !== undefined && typeof update.enabled !== "boolean")
      || (update.soundsEnabled !== undefined && typeof update.soundsEnabled !== "boolean")
      || (update.deviceName !== undefined && update.deviceName !== null && typeof update.deviceName !== "string")) {
      return errorResponse("invalid settings");
    }
    const restartNeeded = update.enabled !== undefined && update.enabled !== persisted.enabled
      || update.deviceName !== undefined && update.deviceName !== persisted.deviceName;
    if (update.enabled !== undefined) persisted.enabled = update.enabled;
    if (update.soundsEnabled !== undefined) persisted.soundsEnabled = update.soundsEnabled;
    if (update.deviceName !== undefined) persisted.deviceName = update.deviceName;
    saveSettings(persisted);
    if (restartNeeded) await restartCapture();
    return Response.json(currentState());
  }
  if (method === "PUT" && route === "/v1/filter") {
    const filter = await readText(request, 128_000);
    if (filter === null) return errorResponse("filter payload is too large", 413);
    const invalid = invalidFilterResponse(filter);
    if (invalid) return invalid;
    persisted.filter = filter;
    persisted.profiles[persisted.active] = filter;
    session.setFilter(filter);
    saveSettings(persisted);
    return Response.json(currentState().filter);
  }
  if (method === "POST" && route === "/v1/profiles") {
    const raw = await readText(request, 32_000);
    if (raw === null) return errorResponse("profile payload is too large", 413);
    let command: ProfileCommand;
    try {
      command = JSON.parse(raw) as ProfileCommand;
    } catch {
      return errorResponse("invalid JSON");
    }

    const name = normalizedProfileName(command.name);
    if (!name) return errorResponse("profile name must be 1-64 letters, numbers, spaces, underscores, or hyphens");
    if (!["create", "activate", "duplicate", "rename"].includes(command.action)) return errorResponse("unknown profile action");
    if (command.action === "create") {
      if (typeof command.text !== "string") return errorResponse("profile text is required");
      const invalid = invalidFilterResponse(command.text);
      if (invalid) return invalid;
      if (Object.hasOwn(persisted.profiles, name)) return errorResponse("profile already exists", 409);
      persisted.profiles[name] = command.text;
    } else if (command.action === "activate") {
      if (!Object.hasOwn(persisted.profiles, name)) return errorResponse("profile not found", 404);
      const invalid = invalidFilterResponse(persisted.profiles[name]!);
      if (invalid) return invalid;
      persisted.active = name;
      persisted.filter = persisted.profiles[name]!;
      session.setFilter(persisted.filter);
    } else {
      const source = normalizedProfileName(command.source);
      if (!source || !Object.hasOwn(persisted.profiles, source)) return errorResponse("source profile not found", 404);
      if (Object.hasOwn(persisted.profiles, name)) return errorResponse("profile already exists", 409);
      persisted.profiles[name] = persisted.profiles[source]!;
      if (command.action === "rename") {
        delete persisted.profiles[source];
        if (persisted.active === source) {
          persisted.active = name;
          persisted.filter = persisted.profiles[name]!;
          session.setFilter(persisted.filter);
        }
      }
    }
    saveSettings(persisted);
    return Response.json(currentState());
  }
  if (method === "POST" && route === "/v1/capture/restart") {
    await restartCapture();
    return Response.json(currentState());
  }
  return errorResponse("not found", 404);
}

function localOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function corsResponse(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (!origin || !localOrigin(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-allow-methods", "GET, PUT, POST, DELETE, OPTIONS");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: DESKTOP_API_PORT,
  async fetch(request) {
    const origin = request.headers.get("origin");
    if (origin && !localOrigin(origin)) return errorResponse("origin is not allowed", 403);
    if (request.method === "OPTIONS") return corsResponse(request, new Response(null, { status: 204 }));
    try {
      return corsResponse(request, await routeRequest(request));
    } catch (error) {
      return corsResponse(request, errorResponse(error instanceof Error ? error.message : String(error), 500));
    }
  },
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await capture?.stop().catch(() => undefined);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await restartCapture();
console.log(`[valeloot] backend ready on 127.0.0.1:${server.port}`);

if (!process.stdin.isTTY) {
  try {
    nativeClient = await NeutralinoClient.fromStdin();
    nativeClient.onClose(() => void shutdown());
    await nativeClient.call("app.broadcast", {
      event: "valeLootBackendReady",
      data: { port: server.port },
    });
  } catch (error) {
    console.error(`[valeloot] Neutralino bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    await shutdown();
    process.exitCode = 1;
  }
}
