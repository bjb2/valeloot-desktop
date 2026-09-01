import { getNpcapStatus, listNpcapDevices, PacketCapture } from "@kar-mi/spirit-vale-tools-capture/capture";
import type { CaptureBackendStatus, CaptureDeviceRecord } from "./linux-pcap.ts";
import { LinuxPcapRuntime } from "./linux-pcap.ts";
import { LinuxTargetSnapshotProvider } from "./linux-target-provider.ts";
import type { LinuxCaptureMode } from "../../shared/contracts.ts";

let linuxCaptureMode: LinuxCaptureMode = "auto";
let linuxRuntime = new LinuxPcapRuntime(linuxCaptureMode);
const linuxTargetProvider = new LinuxTargetSnapshotProvider();

/**
 * Update the Linux capture mode. Returns true if the mode changed (indicating
 * that capture should be restarted to take effect).
 */
export function setLinuxCaptureMode(mode: LinuxCaptureMode): boolean {
  if (mode === linuxCaptureMode) return false;
  linuxCaptureMode = mode;
  // Recreate the runtime so the cached readyStatus is cleared and the new mode is applied.
  linuxRuntime = new LinuxPcapRuntime(mode);
  return true;
}

export function getLinuxCaptureMode(): LinuxCaptureMode {
  return linuxCaptureMode;
}

export async function getCaptureStatus(): Promise<CaptureBackendStatus> {
  if (process.platform === "linux") return linuxRuntime.status();
  if (process.platform === "win32") return getNpcapStatus();
  return { availability: "error", detail: `Live packet capture is not supported on ${process.platform}` };
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

export function captureBackendName(): string {
  if (process.platform === "linux") {
    if (linuxCaptureMode === "dumpcap") return "dumpcap";
    if (linuxCaptureMode === "libpcap") return "libpcap (direct)";
    return "libpcap";
  }
  return process.platform === "win32" ? "Npcap" : "Packet capture";
}
