import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import {
  getNpcapStatus,
  listNpcapDevices,
  PacketCapture,
  resolveCaptureDevice as resolveWindowsCaptureDevice,
  type NpcapDevice,
} from "@kar-mi/spirit-vale-tools-capture/capture";
import type { LinuxCaptureMode } from "../../shared/contracts.ts";
import {
  LinuxPcapRuntime,
  type CaptureBackendStatus,
  type CaptureDeviceRecord,
} from "./linux-pcap.ts";
import { LinuxTargetSnapshotProvider } from "./linux-target-provider.ts";

export interface ResolvedCaptureDevice {
  device?: CaptureDeviceRecord;
  usedFallback: boolean;
  detail?: string;
}

export interface CaptureHealthInput {
  running: boolean;
  gameDetected: boolean;
  targetActiveAtMs?: number;
  lastAttributedPacketAtMs?: number;
  nowMs: number;
  timeoutMs: number;
  adapter: string;
}

let linuxCaptureMode: LinuxCaptureMode = "auto";
let linuxRuntime = new LinuxPcapRuntime(linuxCaptureMode);
const linuxTargetProvider = new LinuxTargetSnapshotProvider();

export function setLinuxCaptureMode(mode: LinuxCaptureMode): boolean {
  if (mode === linuxCaptureMode) return false;
  linuxCaptureMode = mode;
  linuxRuntime = new LinuxPcapRuntime(mode);
  return true;
}

export function getLinuxCaptureMode(): LinuxCaptureMode {
  return linuxCaptureMode;
}

export async function getCaptureStatus(): Promise<CaptureBackendStatus> {
  if (process.platform === "linux") return linuxRuntime.status();
  if (process.platform === "win32") return getNpcapStatus();
  return {
    availability: "error",
    detail: `Live packet capture is not supported on ${process.platform}`,
  };
}

export async function listCaptureDevices(): Promise<CaptureDeviceRecord[]> {
  if (process.platform === "linux") return linuxRuntime.listDevices();
  if (process.platform === "win32") return listNpcapDevices();
  return [];
}

export function createPacketCapture(): PacketCapture {
  if (process.platform === "linux") {
    return new PacketCapture({
      runtime: linuxRuntime,
      targetProvider: linuxTargetProvider,
      // The dependency's packet pipeline is platform-neutral, but v2.7.0 retains a Windows-only gate.
      // Its injected runtime and target-provider seams supply all platform-specific behavior here.
      platform: "win32",
    });
  }
  return new PacketCapture();
}

export async function resolveCaptureDevice(
  devices: CaptureDeviceRecord[],
  requestedName?: string,
): Promise<ResolvedCaptureDevice> {
  if (process.platform !== "linux") {
    return resolveWindowsCaptureDevice(
      devices as NpcapDevice[],
      requestedName,
    );
  }
  if (requestedName) {
    const requested = devices.find((device) => device.name === requestedName);
    if (requested) return { device: requested, usedFallback: false };
  }
  const routeInterface = await linuxDefaultRouteInterface();
  const automatic =
    devices.find((device) => device.name === routeInterface) ??
    devices.find(isUsableDevice) ??
    devices[0];
  return {
    ...(automatic === undefined ? {} : { device: automatic }),
    usedFallback: Boolean(requestedName),
    ...(requestedName && automatic
      ? {
          detail:
            "The saved adapter is unavailable; capture is using the automatically selected adapter",
        }
      : {}),
  };
}

export async function linuxDefaultRouteInterface(): Promise<
  string | undefined
> {
  try {
    const process = Bun.spawn(["ip", "-j", "route", "get", "1.1.1.1"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(process.stdout).text();
    if ((await process.exited) === 0) {
      const routes: unknown = JSON.parse(output);
      if (Array.isArray(routes)) {
        const device = routes.find(isRouteRecord)?.dev;
        if (typeof device === "string" && device.length > 0) return device;
      }
    }
  } catch {}
  try {
    const ipv4 = parseProcDefaultRoute(
      await readFile("/proc/net/route", "utf8"),
    );
    if (ipv4) return ipv4;
  } catch {}
  try {
    return parseProcIpv6DefaultRoute(
      await readFile("/proc/net/ipv6_route", "utf8"),
    );
  } catch {
    return undefined;
  }
}

export function parseProcDefaultRoute(text: string): string | undefined {
  let selected: { name: string; metric: number } | undefined;
  for (const line of text.split(/\r?\n/).slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (
      columns.length < 8 ||
      columns[1] !== "00000000" ||
      columns[7] !== "00000000"
    ) {
      continue;
    }
    const flags = Number.parseInt(columns[3]!, 16);
    const metric = Number.parseInt(columns[6]!, 10);
    if (
      !Number.isFinite(flags) ||
      (flags & 1) === 0 ||
      !Number.isFinite(metric)
    ) {
      continue;
    }
    if (!selected || metric < selected.metric) {
      selected = { name: columns[0]!, metric };
    }
  }
  return selected?.name;
}

export function parseProcIpv6DefaultRoute(text: string): string | undefined {
  let selected: { name: string; metric: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (
      columns.length < 10 ||
      columns[0] !== "0".repeat(32) ||
      columns[1] !== "00"
    ) {
      continue;
    }
    const metric = Number.parseInt(columns[5]!, 16);
    const flags = Number.parseInt(columns[8]!, 16);
    if (
      !Number.isFinite(metric) ||
      !Number.isFinite(flags) ||
      (flags & 1) === 0
    ) {
      continue;
    }
    if (!selected || metric < selected.metric) {
      selected = { name: columns[9]!, metric };
    }
  }
  return selected?.name;
}

export function isAutomaticCaptureCandidate(
  device: CaptureDeviceRecord,
): boolean {
  return (
    !device.loopback &&
    device.addresses.some((address) => {
      const normalized = address.split("%", 1)[0]!.toLowerCase();
      const version = isIP(normalized);
      if (version === 4) {
        return (
          normalized !== "0.0.0.0" &&
          !normalized.startsWith("127.") &&
          !normalized.startsWith("169.254.")
        );
      }
      if (version === 6) {
        return (
          normalized !== "::" &&
          normalized !== "::1" &&
          !normalized.startsWith("fe80:")
        );
      }
      return false;
    })
  );
}

export function automaticCaptureRouteChanged(
  automatic: boolean,
  currentDeviceName: string | undefined,
  nextDeviceName: string | undefined,
): boolean {
  return (
    automatic &&
    currentDeviceName !== undefined &&
    nextDeviceName !== undefined &&
    currentDeviceName !== nextDeviceName
  );
}

export function captureHealthWarning(
  input: CaptureHealthInput,
): string | undefined {
  if (
    !input.running ||
    !input.gameDetected ||
    input.targetActiveAtMs === undefined
  ) {
    return undefined;
  }
  if (
    input.lastAttributedPacketAtMs !== undefined &&
    input.lastAttributedPacketAtMs >= input.targetActiveAtMs
  ) {
    return undefined;
  }
  if (input.nowMs - input.targetActiveAtMs < input.timeoutMs) return undefined;
  return `Spirit Vale is running, but no attributed game traffic reached ${input.adapter}. A VPN or route optimizer such as ExitLag may be using another adapter; select its active adapter below.`;
}

export function captureBackendName(): string {
  if (process.platform === "linux") {
    if (linuxCaptureMode === "dumpcap") return "dumpcap";
    if (linuxCaptureMode === "libpcap") return "libpcap (direct)";
    return "libpcap";
  }
  return process.platform === "win32" ? "Npcap" : "Packet capture";
}

function isRouteRecord(value: unknown): value is { dev: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "dev" in value &&
    typeof value.dev === "string"
  );
}

function isUsableDevice(device: CaptureDeviceRecord): boolean {
  const label = `${device.name} ${device.description}`.toLowerCase();
  return (
    !device.loopback &&
    device.addresses.length > 0 &&
    !["bluetooth", "docker", "veth", "vmware", "virtualbox"].some((value) =>
      label.includes(value),
    )
  );
}
