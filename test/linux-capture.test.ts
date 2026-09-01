import { describe, expect, test } from "bun:test";
import { PcapStreamDecoder } from "../src/backend/capture/linux-pcap.ts";
import { matchesLinuxProcessName, parseProcNetTable } from "../src/backend/capture/linux-target-provider.ts";

const PROC_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

describe("Linux target discovery", () => {
  test("recognizes a Wine executable from comm or a Windows-style command line", () => {
    expect(matchesLinuxProcessName("SpiritVale.exe", "SpiritVale.exe\n", "")).toBe(true);
    expect(matchesLinuxProcessName("SpiritVale.exe", "wine64-preloader\n", "Z:\\Games\\Spirit Vale\\SpiritVale.exe\0--launcher\0")).toBe(true);
    expect(matchesLinuxProcessName("SpiritVale.exe", "other.exe\n", "wine64\0Z:\\Games\\Other.exe\0")).toBe(false);
  });

  test("maps owned IPv4 and IPv6 socket inodes to capture endpoints", () => {
    const ipv4 = `${PROC_HEADER}  4: 0100007F:C350 00000000:0000 07 00000000:00000000 00:00000000 00000000 1000 0 4242\n`;
    const ipv6 = `${PROC_HEADER}  5: 00000000000000000000000001000000:1770 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000 1000 0 4343\n`;

    expect(parseProcNetTable("udp", false, ipv4, 77, new Set(["4242"]))).toEqual([
      { protocol: "udp", address: "127.0.0.1", port: 50_000, processId: 77 },
    ]);
    expect(parseProcNetTable("udp", true, ipv6, 77, new Set(["4343"]))).toEqual([
      { protocol: "udp", address: "::1", port: 6_000, processId: 77 },
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
    expect(packets[0]?.capturedAt.toISOString()).toBe("1970-01-01T00:00:01.250Z");
    expect(packets[0]?.timestampTicks).toBe(12_500_000n);
    expect(packets[0]?.data).toEqual(Buffer.from([1, 2, 3]));
    expect(packets[0]?.originalLength).toBe(5);
  });
});
