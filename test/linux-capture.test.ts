import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  findDumpcap,
  normalizeDataLinkForPacketCapture,
  PcapStreamDecoder,
} from "../src/backend/capture/linux-pcap.ts";
import {
  matchesLinuxProcessName,
  parseProcNetTable,
} from "../src/backend/capture/linux-target-provider.ts";

const PROC_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

describe("Linux target discovery", () => {
  test("recognizes a Wine executable from comm or a Windows-style command line", () => {
    expect(
      matchesLinuxProcessName("SpiritVale.exe", "SpiritVale.exe\n", ""),
    ).toBe(true);
    expect(
      matchesLinuxProcessName(
        "SpiritVale.exe",
        "wine64-preloader\n",
        "Z:\\Games\\Spirit Vale\\SpiritVale.exe\0--launcher\0",
      ),
    ).toBe(true);
    expect(
      matchesLinuxProcessName(
        "SpiritVale.exe",
        "other.exe\n",
        "wine64\0Z:\\Games\\Other.exe\0",
      ),
    ).toBe(false);
  });

  test("maps owned IPv4 and IPv6 socket inodes to capture endpoints", () => {
    const ipv4 = `${PROC_HEADER}  4: 0100007F:C350 00000000:0000 07 00000000:00000000 00:00000000 00000000 1000 0 4242\n`;
    const ipv6 = `${PROC_HEADER}  5: 00000000000000000000000001000000:1770 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000 1000 0 4343\n`;

    expect(
      parseProcNetTable("udp", false, ipv4, 77, new Set(["4242"])),
    ).toEqual([
      { protocol: "udp", address: "127.0.0.1", port: 50_000, processId: 77 },
    ]);
    expect(parseProcNetTable("udp", true, ipv6, 77, new Set(["4343"]))).toEqual(
      [{ protocol: "udp", address: "::1", port: 6_000, processId: 77 }],
    );
  });
});

describe("pcap link-type normalization", () => {
  test("maps Linux raw-IP interfaces to the supported raw packet format", () => {
    expect(normalizeDataLinkForPacketCapture(101)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(12)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(113)).toBe(113);
  });

  test("keeps VPN and tunnel adapters available for Linux capture selection", () => {
    const devices = [
      {
        name: "enp3s0",
        description: "enp3s0",
        addresses: ["192.168.1.10"],
        loopback: false,
      },
      {
        name: "tailscale0",
        description: "tailscale0",
        addresses: ["100.100.107.15"],
        loopback: false,
      },
      {
        name: "wg0",
        description: "WireGuard",
        addresses: ["10.0.0.2"],
        loopback: false,
      },
      {
        name: "lo",
        description: "lo",
        addresses: ["127.0.0.1"],
        loopback: true,
      },
    ];

    expect(devices.map((device) => device.name)).toEqual([
      "enp3s0",
      "tailscale0",
      "wg0",
      "lo",
    ]);
  });
});

describe("dumpcap pcap stream", () => {
  test("decodes a packet split across stream chunks", () => {
    const stream = Buffer.alloc(24 + 16 + 3);
    stream.writeUInt32LE(0xa1b2c3d4, 0);
    stream.writeUInt16LE(2, 4);
    stream.writeUInt16LE(4, 6);
    stream.writeUInt32LE(65_535, 16);
    stream.writeUInt32LE(1, 20);
    stream.writeUInt32LE(1, 24);
    stream.writeUInt32LE(250_000, 28);
    stream.writeUInt32LE(3, 32);
    stream.writeUInt32LE(5, 36);
    stream.set([1, 2, 3], 40);

    const decoder = new PcapStreamDecoder();
    expect(decoder.feed(stream.subarray(0, 19))).toEqual([]);
    const packets = decoder.feed(stream.subarray(19));

    expect(decoder.dataLink).toBe(1);
    expect(packets).toHaveLength(1);
    expect(packets[0]?.capturedAt.toISOString()).toBe(
      "1970-01-01T00:00:01.250Z",
    );
    expect(packets[0]?.timestampTicks).toBe(12_500_000n);
    expect(packets[0]?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(packets[0]?.originalLength).toBe(5);
  });
});

describe("Linux capture mode configuration", () => {
  test("toggles mode and updates captureBackendName", async () => {
    const { getLinuxCaptureMode, setLinuxCaptureMode, captureBackendName } =
      await import("../src/backend/capture/platform-capture.ts");

    // Set auto
    setLinuxCaptureMode("auto");
    expect(getLinuxCaptureMode()).toBe("auto");
    if (process.platform === "linux") {
      expect(captureBackendName()).toBe("libpcap");
    }

    // Set dumpcap
    expect(setLinuxCaptureMode("dumpcap")).toBe(true);
    expect(getLinuxCaptureMode()).toBe("dumpcap");
    if (process.platform === "linux") {
      expect(captureBackendName()).toBe("dumpcap");
    }

    // Setting same mode returns false
    expect(setLinuxCaptureMode("dumpcap")).toBe(false);

    // Set libpcap
    expect(setLinuxCaptureMode("libpcap")).toBe(true);
    expect(getLinuxCaptureMode()).toBe("libpcap");
    if (process.platform === "linux") {
      expect(captureBackendName()).toBe("libpcap (direct)");
    }

    // Reset back to auto
    setLinuxCaptureMode("auto");
  });

  test("finds dumpcap from PATH when it is not in the default system directories", () => {
    const previousPath = process.env.PATH;
    const previousOverride = process.env.VALELOOT_DUMPCAP;
    const tempDir = mkdtempSync(join(tmpdir(), "valeloot-dumpcap-"));
    const dumpcapPath = join(tempDir, "dumpcap");

    try {
      writeFileSync(dumpcapPath, "#!/bin/sh\nexit 0\n");
      chmodSync(dumpcapPath, 0o755);
      process.env.PATH = [tempDir, previousPath].filter(Boolean).join(delimiter);
      delete process.env.VALELOOT_DUMPCAP;

      expect(findDumpcap()).toBe(dumpcapPath);
    } finally {
      process.env.PATH = previousPath;
      if (previousOverride === undefined) delete process.env.VALELOOT_DUMPCAP;
      else process.env.VALELOOT_DUMPCAP = previousOverride;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("finds Homebrew dumpcap in common install directories", () => {
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousOverride = process.env.VALELOOT_DUMPCAP;
    const tempHome = mkdtempSync(join(tmpdir(), "valeloot-home-"));
    const homebrewBin = join(tempHome, ".linuxbrew", "bin");
    const dumpcapPath = join(homebrewBin, "dumpcap");

    try {
      mkdirSync(homebrewBin, { recursive: true });
      writeFileSync(dumpcapPath, "#!/bin/sh\nexit 0\n");
      chmodSync(dumpcapPath, 0o755);
      process.env.HOME = tempHome;
      process.env.PATH = "";
      delete process.env.VALELOOT_DUMPCAP;

      expect(findDumpcap()).toBe(dumpcapPath);
    } finally {
      process.env.HOME = previousHome;
      process.env.PATH = previousPath;
      if (previousOverride === undefined) delete process.env.VALELOOT_DUMPCAP;
      else process.env.VALELOOT_DUMPCAP = previousOverride;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
