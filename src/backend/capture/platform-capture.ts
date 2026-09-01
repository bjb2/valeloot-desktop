import { getNpcapStatus, listNpcapDevices, PacketCapture } from "@kar-mi/spirit-vale-tools-capture/capture";
import type { CaptureBackendStatus, CaptureDeviceRecord } from "./linux-pcap.ts";
import { LinuxPcapRuntime } from "./linux-pcap.ts";
import { LinuxTargetSnapshotProvider } from "./linux-target-provider.ts";

const linuxRuntime = new LinuxPcapRuntime();
const linuxTargetProvider = new LinuxTargetSnapshotProvider();

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
  return process.platform === "linux" ? "libpcap" : process.platform === "win32" ? "Npcap" : "Packet capture";
}
