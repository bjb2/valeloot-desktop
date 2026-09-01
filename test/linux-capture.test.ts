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
  normalizeCapturedFrame,
  normalizeDataLinkForPacketCapture,
  PcapStreamDecoder,
} from "../src/backend/capture/linux-pcap.ts";
import {
  matchesLinuxProcessName,
  parseProcNetTable,
} from "../src/backend/capture/linux-target-provider.ts";
import {
  automaticCaptureRouteChanged,
  captureHealthWarning,
  isAutomaticCaptureCandidate,
  parseProcDefaultRoute,
  parseProcIpv6DefaultRoute,
} from "../src/backend/capture/platform-capture.ts";

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
    expect(normalizeDataLinkForPacketCapture(228)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(229)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(276)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(12)).toBe(12);
    expect(normalizeDataLinkForPacketCapture(113)).toBe(113);
  });

  test("strips Linux cooked-v2 headers before raw-IP decoding", () => {
    const frame = Buffer.concat([Buffer.alloc(20, 0xaa), Buffer.from([0x45, 0, 0, 20])]);
    expect(normalizeCapturedFrame(frame, 276)).toEqual(
      Buffer.from([0x45, 0, 0, 20]),
    );
    expect(normalizeCapturedFrame(frame, 1)).toBe(frame);
  });
});

describe("VPN-aware capture routing", () => {
  const ethernet = {
    name: "enp3s0",
    description: "Ethernet",
    addresses: ["192.168.1.10"],
    loopback: false,
  };
  const tunnel = {
    name: "tailscale0",
    description: "Tailscale Tunnel",
    addresses: ["100.100.107.15"],
    loopback: false,
  };

  test("selects the lowest-metric active IPv4 default route", () => {
    const table = [
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask",
      "enp3s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000",
      "tailscale0\t00000000\t00000000\t0001\t0\t0\t50\t00000000",
    ].join("\n");
    expect(parseProcDefaultRoute(table)).toBe("tailscale0");
  });

  test("falls back to the lowest-metric active IPv6 default route", () => {
    const zero = "0".repeat(32);
    const table = [
      `${zero} 00 ${zero} 00 ${zero} 00000064 00000000 00000000 00000001 enp3s0`,
      `${zero} 00 ${zero} 00 ${zero} 0000000a 00000000 00000000 00000001 tun0`,
    ].join("\n");
    expect(parseProcIpv6DefaultRoute(table)).toBe("tun0");
  });

  test("excludes loopback and link-local adapters from Automatic", () => {
    expect(isAutomaticCaptureCandidate(ethernet)).toBe(true);
    expect(isAutomaticCaptureCandidate(tunnel)).toBe(true);
    expect(
      isAutomaticCaptureCandidate({
        name: "stale-tap",
        description: "Inactive TAP",
        addresses: ["169.254.20.4", "fe80::1"],
        loopback: false,
      }),
    ).toBe(false);
    expect(
      isAutomaticCaptureCandidate({
        name: "lo",
        description: "Loopback",
        addresses: ["127.0.0.1"],
        loopback: true,
      }),
    ).toBe(false);
  });

  test("restarts only Automatic capture when the routed adapter changes", () => {
    expect(automaticCaptureRouteChanged(true, ethernet.name, tunnel.name)).toBe(
      true,
    );
    expect(automaticCaptureRouteChanged(false, ethernet.name, tunnel.name)).toBe(
      false,
    );
    expect(
      automaticCaptureRouteChanged(true, tunnel.name, tunnel.name),
    ).toBe(false);
  });

  test("warns after an active game receives no attributed tunnel traffic", () => {
    expect(
      captureHealthWarning({
        running: true,
        gameDetected: true,
        targetActiveAtMs: 1_000,
        nowMs: 20_999,
        timeoutMs: 20_000,
        adapter: tunnel.description,
      }),
    ).toBeUndefined();
    expect(
      captureHealthWarning({
        running: true,
        gameDetected: true,
        targetActiveAtMs: 1_000,
        nowMs: 21_000,
        timeoutMs: 20_000,
        adapter: tunnel.description,
      }),
    ).toBe(
      "Spirit Vale is running, but no attributed game traffic reached Tailscale Tunnel. A VPN or route optimizer such as ExitLag may be using another adapter; select its active adapter below.",
    );
    expect(
      captureHealthWarning({
        running: true,
        gameDetected: true,
        targetActiveAtMs: 1_000,
        lastAttributedPacketAtMs: 1_001,
        nowMs: 30_000,
        timeoutMs: 20_000,
        adapter: tunnel.description,
      }),
    ).toBeUndefined();
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
