import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CaptureConnectionEvent, CaptureTargetStatus } from "@kar-mi/spirit-vale-tools-capture";
import type { PacketCapture } from "@kar-mi/spirit-vale-tools-capture/capture";
import { serializeCollectorMessage } from "../shared/collector-protocol.ts";
import type { DesktopSettingsUpdate, DesktopState, ProfileCommand } from "../shared/contracts.ts";
import { DESKTOP_API_PORT } from "../shared/contracts.ts";
import { createDiagnosticLogger, formatError } from "../shared/diagnostics.ts";
import { LootSession } from "../core/loot-session.ts";
import { parseLootFilter } from "../core/filter/loot-dsl.ts";
import { consumeFishNetPacket } from "../core/packet-consumer.ts";
import { FishNetCaptureDecoder } from "./fishnet-capture-decoder.ts";
import {
  automaticCaptureRouteChanged,
  captureBackendName,
  captureHealthWarning as buildCaptureHealthWarning,
  createPacketCapture,
  getCaptureStatus,
  getLinuxCaptureMode,
  isAutomaticCaptureCandidate,
  listCaptureDevices,
  resolveCaptureDevice,
  setLinuxCaptureMode,
  type ResolvedCaptureDevice,
} from "./capture/platform-capture.ts";
import type { CaptureDeviceRecord } from "./capture/linux-pcap.ts";
import { canonicalSoundName, findCustomSound, listCustomSounds, SOUND_NAMES, SOUND_WAVS } from "./sounds.ts";

type Persisted = {
  enabled: boolean;
  soundsEnabled: boolean;
  deviceName: string | null;
  linuxCaptureMode: "auto" | "libpcap" | "dumpcap";
  filter: string;
  active: string;
  profiles: Record<string, string>;
};

const root = path.resolve(process.env.VALELOOT_APP_ROOT ?? path.resolve(import.meta.dir, "../.."));
const applicationVersion = process.env.VALELOOT_VERSION ?? (() => {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("package.json does not contain an application version.");
  }
  return packageJson.version;
})();
const portable = existsSync(path.join(root, ".valeloot-portable"));
const defaultDataRoot = process.platform === "win32"
  ? process.env.LOCALAPPDATA
  : process.env.XDG_CONFIG_HOME ?? (process.env.HOME ? path.join(process.env.HOME, ".config") : undefined);
const dataDirectory = path.resolve(process.env.VALELOOT_DATA_DIR
  ?? (portable ? path.join(root, "data") : path.join(defaultDataRoot ?? root, "ValeLoot Desktop")));
const rendererDirectory = path.resolve(process.env.VALELOOT_RENDERER_DIR ?? path.join(root, "resources", "views", "main"));
const logsDirectory = path.join(dataDirectory, "logs");
const diagnostics = createDiagnosticLogger("collector", process.env.VALELOOT_LOG_FILE ?? path.join(logsDirectory, "collector.log"));
diagnostics.info("Collector process starting", {
  version: applicationVersion,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  root,
  dataDirectory,
  rendererDirectory,
  captureBackend: captureBackendName(),
});
const settingsPath = path.join(dataDirectory, "settings.json");
const soundsDirectory = path.join(dataDirectory, "sounds");
const iconDirectory = existsSync(path.join(import.meta.dir, "icons"))
  ? path.join(import.meta.dir, "icons")
  : path.join(root, "assets", "icons");
const starterFilterPath = existsSync(path.join(import.meta.dir, "starter-ruleset.txt"))
  ? path.join(import.meta.dir, "starter-ruleset.txt")
  : path.join(root, "docs", "starter-ruleset.txt");
const starterFilter = readFileSync(starterFilterPath, "utf8");
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
mkdirSync(soundsDirectory, { recursive: true });

function defaultSettings(): Persisted {
  return {
    enabled: true,
    soundsEnabled: true,
    deviceName: null,
    linuxCaptureMode: "auto",
    filter: starterFilter,
    active: "Default",
    profiles: { Default: starterFilter },
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
      linuxCaptureMode: (raw.linuxCaptureMode === "libpcap" || raw.linuxCaptureMode === "dumpcap") ? raw.linuxCaptureMode : "auto",
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
setLinuxCaptureMode(persisted.linuxCaptureMode);
const session = new LootSession({
  soundsEnabled: () => persisted.soundsEnabled,
  onSound: async (sound) => {
    const requested = canonicalSoundName(sound);
    const builtin = requested?.toLowerCase();
    const custom = builtin && !Object.hasOwn(SOUND_WAVS, builtin) ? findCustomSound(soundsDirectory, builtin) : null;
    const name = builtin && Object.hasOwn(SOUND_WAVS, builtin) ? builtin : custom?.name;
    if (!name) return false;
    try {
      process.stdout.write(serializeCollectorMessage({ type: "play-sound", name }));
      return true;
    } catch (error) {
      warning = `Could not dispatch alert sound: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  },
});
session.setFilter(persisted.filter);

let captureStatus: DesktopState["capture"] = {
  backend: captureBackendName(),
  availability: "missing",
  detail: `Checking ${captureBackendName()}`,
};
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
let resolvedCaptureDevice: CaptureDeviceRecord | undefined;
let captureHealthWarning: string | undefined;
let lastAttributedPacketAt: string | undefined;
let lastAttributedPacketAtMs: number | undefined;
let targetActiveAtMs: number | undefined;
let automaticCaptureRestarts = 0;
let routeCheckRunning = false;
let routeMonitor: NodeJS.Timeout | undefined;
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
  onWarning: (message) => {
    warning = message;
    diagnostics.warn("FishNet decoder warning", { message });
  },
});

const CAPTURE_HEALTH_TIMEOUT_MS = 20_000;
const ROUTE_CHECK_INTERVAL_MS = 5_000;

interface CaptureRestartOptions {
  preserveDecoder?: boolean;
  reason?: "settings" | "manual" | "route-change" | "startup";
}

let captureRestartChain: Promise<void> = Promise.resolve();

function adapterLabel(device = resolvedCaptureDevice): string {
  return device?.description || device?.name || "the selected adapter";
}

async function resolveDesiredCaptureDevice(): Promise<
  ResolvedCaptureDevice & { device: CaptureDeviceRecord }
> {
  const devices = await listCaptureDevices();
  const automaticCandidates = devices.filter(isAutomaticCaptureCandidate);
  if (persisted.deviceName !== null) {
    const requested = devices.find(
      (device) => device.name === persisted.deviceName,
    );
    if (requested) {
      return { device: requested, usedFallback: false };
    }
    const fallback = await resolveCaptureDevice(automaticCandidates);
    if (!fallback.device) {
      throw new Error(
        "The saved capture adapter is unavailable and no active fallback adapter was found",
      );
    }
    return {
      device: fallback.device,
      usedFallback: true,
      detail:
        "The saved adapter is unavailable; capture is using the active default-route adapter",
    };
  }
  const resolution = await resolveCaptureDevice(automaticCandidates);
  if (!resolution.device) {
    throw new Error("No active capture adapter with a routable address was found");
  }
  return {
    ...resolution,
    device: resolution.device,
  };
}

function scheduleCaptureRestart(
  options: CaptureRestartOptions = {},
): Promise<void> {
  const scheduled = captureRestartChain
    .catch((error) => {
      diagnostics.error("Previous capture restart failed", {
        error: formatError(error),
      });
    })
    .then(() => restartCapture(options));
  captureRestartChain = scheduled;
  return scheduled;
}

async function restartCapture(
  options: CaptureRestartOptions = {},
): Promise<void> {
  const preserveDecoder = options.preserveDecoder === true;
  const previousGameDetected = gameDetected;
  diagnostics.info("Restarting packet capture", {
    enabled: persisted.enabled,
    requestedDevice: persisted.deviceName,
    preserveDecoder,
    reason: options.reason ?? "manual",
  });
  await capture
    ?.stop()
    .catch((error) =>
      diagnostics.warn("Previous packet capture did not stop cleanly", {
        error: formatError(error),
      }),
    );
  if (!preserveDecoder) fishNetDecoder.reset();
  capture = undefined;
  resolvedCaptureDevice = undefined;
  captureHealthWarning = undefined;
  if (!preserveDecoder) {
    gameDetected = false;
    activeConnectionId = undefined;
    targetActiveAtMs = undefined;
  }
  warning = undefined;

  if (!persisted.enabled) {
    phase = "disabled";
    detail = "Capture disabled";
    diagnostics.info("Packet capture remains disabled by settings");
    return;
  }

  try {
    captureStatus = {
      backend: captureBackendName(),
      ...(await getCaptureStatus()),
    };
  } catch (error) {
    captureStatus = {
      backend: captureBackendName(),
      availability: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  diagnostics.info("Capture backend status resolved", { ...captureStatus });
  if (captureStatus.availability !== "ready") {
    phase = "capture-unavailable";
    detail = captureStatus.detail;
    diagnostics.warn("Capture backend unavailable", { ...captureStatus });
    return;
  }

  try {
    const resolution = await resolveDesiredCaptureDevice();
    resolvedCaptureDevice = resolution.device;
    if (resolution.usedFallback && resolution.detail) {
      warning = resolution.detail;
    }
    diagnostics.debug("Creating packet capture pipeline", {
      adapter: adapterLabel(),
      selection: persisted.deviceName === null ? "automatic" : "manual",
      usedFallback: resolution.usedFallback,
    });
    const nextCapture = createPacketCapture();
    nextCapture.on("targetStatus", (status: CaptureTargetStatus) => {
      const wasDetected = gameDetected;
      gameDetected = status.state === "active";
      if (wasDetected !== gameDetected) {
        targetActiveAtMs = gameDetected ? Date.now() : undefined;
        if (!gameDetected) captureHealthWarning = undefined;
      }
      phase = gameDetected ? "capturing" : "waiting-for-game";
      detail = gameDetected
        ? `Spirit Vale detected on ${adapterLabel()}`
        : `Waiting for Spirit Vale on ${adapterLabel()}`;
      diagnostics.info("Target process status changed", { status });
      if (!gameDetected) activeConnectionId = undefined;
    });
    nextCapture.on("connection", (event: CaptureConnectionEvent) => {
      diagnostics.info("Game connection state changed", { event });
      if (event.state === "opened") {
        if (activeConnectionId !== event.connectionId) {
          session.resetCharacter();
        }
        activeConnectionId = event.connectionId;
        detail = `Spirit Vale connection observed on ${adapterLabel()}`;
      } else if (activeConnectionId === event.connectionId) {
        activeConnectionId = undefined;
        detail = gameDetected
          ? `Waiting for Spirit Vale to reconnect on ${adapterLabel()}`
          : `Waiting for Spirit Vale on ${adapterLabel()}`;
      }
    });
    nextCapture.on("liteNetPacket", (packet) => {
      const observedAt = new Date();
      lastAttributedPacketAt = observedAt.toISOString();
      lastAttributedPacketAtMs = observedAt.getTime();
      captureHealthWarning = undefined;
      fishNetDecoder.consume(packet);
    });
    nextCapture.on("warning", (message: string) => {
      diagnostics.warn("Packet capture warning", { message });
      warning = message;
      const duplicateMatch =
        /(?:suppressed|ignored)\s+(\d+)\s+duplicate/i.exec(message);
      if (duplicateMatch?.[1]) {
        duplicateSnapshots += Number.parseInt(duplicateMatch[1], 10);
      }
    });
    nextCapture.on("error", (error: Error) => {
      if (capture === nextCapture) capture = undefined;
      phase = "error";
      detail = error.message;
      diagnostics.error("Packet capture error", {
        error: formatError(error),
      });
    });
    diagnostics.info("Starting packet capture", {
      protocols: ["udp"],
      targetProcessName: "SpiritVale.exe",
      requestedDevice: persisted.deviceName,
      resolvedDevice: resolution.device.name,
    });
    await nextCapture.start({
      protocols: ["udp"],
      targetProcessName: "SpiritVale.exe",
      decodeLiteNetLib: true,
      deviceName: resolution.device.name,
    });
    capture = nextCapture;
    if (preserveDecoder && previousGameDetected) {
      gameDetected = true;
      targetActiveAtMs = Date.now();
    }
    phase = gameDetected ? "capturing" : "waiting-for-game";
    detail = gameDetected
      ? `Spirit Vale detected on ${adapterLabel()}`
      : `Waiting for Spirit Vale on ${adapterLabel()}`;
    diagnostics.info("Packet capture started", {
      phase,
      detail,
      adapter: adapterLabel(),
      selection: persisted.deviceName === null ? "automatic" : "manual",
    });
  } catch (error) {
    phase = "error";
    detail = error instanceof Error ? error.message : String(error);
    diagnostics.error("Packet capture startup failed", {
      error: formatError(error),
    });
  }
}

function updateCaptureHealth(): void {
  const nextWarning = buildCaptureHealthWarning({
    running: capture !== undefined,
    gameDetected,
    ...(targetActiveAtMs === undefined ? {} : { targetActiveAtMs }),
    ...(lastAttributedPacketAtMs === undefined
      ? {}
      : { lastAttributedPacketAtMs }),
    nowMs: Date.now(),
    timeoutMs: CAPTURE_HEALTH_TIMEOUT_MS,
    adapter: adapterLabel(),
  });
  if (nextWarning && nextWarning !== captureHealthWarning) {
    diagnostics.warn("Capture health detected no attributed traffic", {
      adapter: adapterLabel(),
      automaticDevice: persisted.deviceName === null,
    });
  }
  captureHealthWarning = nextWarning;
}

async function checkAutomaticCaptureDevice(): Promise<void> {
  updateCaptureHealth();
  if (
    capture === undefined ||
    persisted.deviceName !== null ||
    captureStatus.availability !== "ready"
  ) {
    return;
  }
  const resolution = await resolveDesiredCaptureDevice();
  if (
    !automaticCaptureRouteChanged(
      true,
      resolvedCaptureDevice?.name,
      resolution.device.name,
    )
  ) {
    return;
  }
  const previous = resolvedCaptureDevice;
  automaticCaptureRestarts += 1;
  diagnostics.info("Automatic capture route changed", {
    from: adapterLabel(previous),
    to: adapterLabel(resolution.device),
    restart: automaticCaptureRestarts,
  });
  await scheduleCaptureRestart({
    preserveDecoder: gameDetected,
    reason: "route-change",
  });
}

function startRouteMonitor(): void {
  if (routeMonitor !== undefined) return;
  routeMonitor = setInterval(() => {
    if (routeCheckRunning) return;
    routeCheckRunning = true;
    void checkAutomaticCaptureDevice()
      .catch((error) =>
        diagnostics.warn("Automatic capture route check failed", {
          error: formatError(error),
        }),
      )
      .finally(() => {
        routeCheckRunning = false;
      });
  }, ROUTE_CHECK_INTERVAL_MS);
  routeMonitor.unref();
}

function currentState(): DesktopState {
  const stateWarning = captureHealthWarning ?? warning;
  return {
    version: applicationVersion,
    enabled: persisted.enabled,
    soundsEnabled: persisted.soundsEnabled,
    deviceName: persisted.deviceName,
    linuxCaptureMode: persisted.linuxCaptureMode,
    ...(resolvedCaptureDevice === undefined
      ? {}
      : {
          captureAdapter: {
            name: resolvedCaptureDevice.name,
            description: adapterLabel(),
            selection:
              persisted.deviceName === null
                ? ("automatic" as const)
                : ("manual" as const),
            automaticCandidate:
              isAutomaticCaptureCandidate(resolvedCaptureDevice),
          },
        }),
    phase,
    detail,
    capture: captureStatus,
    gameDetected,
    packetsObserved,
    ...(lastAttributedPacketAt === undefined
      ? {}
      : { lastAttributedPacketAt }),
    automaticCaptureRestarts,
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
    logsDirectory,
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
  if (method === "GET") {
    const asset = route === "/" || route === "/index.html"
      ? { filename: "index.html", contentType: "text/html; charset=utf-8" }
      : route === "/index.js"
        ? { filename: "index.js", contentType: "text/javascript; charset=utf-8" }
        : route === "/index.css"
          ? { filename: "index.css", contentType: "text/css; charset=utf-8" }
          : undefined;
    if (asset) {
      const file = Bun.file(path.join(rendererDirectory, asset.filename));
      if (!await file.exists()) return errorResponse("desktop renderer is missing", 500);
      return new Response(file, {
        headers: {
          "cache-control": "no-cache",
          "content-type": asset.contentType,
        },
      });
    }
  }


  if (method === "GET" && route === "/v1/state") return Response.json(currentState());
  if (method === "GET" && route === "/v1/devices") {
    if (captureStatus.availability !== "ready") return Response.json([]);
    const devices = await listCaptureDevices().catch(() => []);
    return Response.json(
      devices
        .map((device) => ({
          ...device,
          automaticCandidate: isAutomaticCaptureCandidate(device),
        }))
        .sort((left, right) => {
          const selectedOrder =
            Number(right.name === resolvedCaptureDevice?.name) -
            Number(left.name === resolvedCaptureDevice?.name);
          if (selectedOrder !== 0) return selectedOrder;
          const candidateOrder =
            Number(right.automaticCandidate) -
            Number(left.automaticCandidate);
          if (candidateOrder !== 0) return candidateOrder;
          return (left.description || left.name).localeCompare(
            right.description || right.name,
          );
        }),
    );
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
      || (update.deviceName !== undefined && update.deviceName !== null && typeof update.deviceName !== "string")
      || (update.linuxCaptureMode !== undefined && update.linuxCaptureMode !== "auto" && update.linuxCaptureMode !== "libpcap" && update.linuxCaptureMode !== "dumpcap")) {
      return errorResponse("invalid settings");
    }
    const restartNeeded = update.enabled !== undefined && update.enabled !== persisted.enabled
      || update.deviceName !== undefined && update.deviceName !== persisted.deviceName
      || (update.linuxCaptureMode !== undefined && update.linuxCaptureMode !== persisted.linuxCaptureMode);
    if (update.enabled !== undefined) persisted.enabled = update.enabled;
    if (update.soundsEnabled !== undefined) persisted.soundsEnabled = update.soundsEnabled;
    if (update.deviceName !== undefined) persisted.deviceName = update.deviceName;
    if (update.linuxCaptureMode !== undefined) {
      persisted.linuxCaptureMode = update.linuxCaptureMode;
      setLinuxCaptureMode(update.linuxCaptureMode);
    }
    saveSettings(persisted);
    if (restartNeeded) {
      await scheduleCaptureRestart({ reason: "settings" });
    }
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
    await scheduleCaptureRestart({ reason: "manual" });
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
const listeningPort = server.port ?? DESKTOP_API_PORT;

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  diagnostics.info("Collector shutdown requested", { packetsObserved, snapshotsDecoded, partialSnapshots, duplicateSnapshots });
  server.stop(true);
  if (routeMonitor !== undefined) {
    clearInterval(routeMonitor);
    routeMonitor = undefined;
  }
  await capture?.stop().catch((error) => diagnostics.warn("Packet capture did not stop cleanly during shutdown", { error: formatError(error) }));
  diagnostics.info("Collector shutdown completed");
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("uncaughtException", (error) => diagnostics.error("Uncaught collector exception", { error: formatError(error) }));
process.on("unhandledRejection", (error) => diagnostics.error("Unhandled collector rejection", { error: formatError(error) }));

await scheduleCaptureRestart({ reason: "startup" });
startRouteMonitor();
diagnostics.info("Collector HTTP server ready", { port: listeningPort, capture: captureStatus, phase });
process.stderr.write(`[valeloot] collector ready on 127.0.0.1:${listeningPort}\n`);
process.stdout.write(serializeCollectorMessage({ type: "ready", port: listeningPort }));

if (!process.stdin.isTTY) {
  process.stdin.resume();
  process.stdin.once("end", () => {
    void shutdown().then(() => { process.exitCode = 0; });
  });
}
