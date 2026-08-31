import { describe, expect, test } from "bun:test";
import type { CapturedFishNetPacket, CapturedLiteNetLibPacket } from "@kar-mi/spirit-vale-tools-capture";
import { FishNetCaptureDecoder, LiteNetFragmentReassembler } from "../src/backend/fishnet-capture-decoder.ts";

describe("LiteNetLib fragment reassembly", () => {
  test("reassembles out-of-order transport fragments before FishNet decoding", () => {
    const decoded: CapturedFishNetPacket[] = [];
    const warnings: string[] = [];
    let reassembled = 0;
    const decoder = new FishNetCaptureDecoder({
      onPacket: (packet) => decoded.push(packet),
      onWarning: (warning) => warnings.push(warning),
      onFragmentReassembled: () => { reassembled += 1; },
    });
    const payload = Buffer.from([1, 0, 0, 0, 1, 0, 0]);

    decoder.consume(fragmentPacket(41, 1, 2, payload.subarray(4)));
    expect(decoded).toHaveLength(0);
    decoder.consume(fragmentPacket(41, 0, 2, payload.subarray(0, 4)));

    expect(decoded.map((packet) => packet.packetName)).toEqual(["authenticated"]);
    expect(reassembled).toBe(1);
    expect(warnings).toEqual([]);
  });

  test("deduplicates retransmitted parts without duplicating the completed message", () => {
    let reassembled = 0;
    const reassembler = new LiteNetFragmentReassembler(() => 100, () => { reassembled += 1; });
    const first = fragmentPacket(7, 0, 2, Buffer.from("first"));
    const second = fragmentPacket(7, 1, 2, Buffer.from("second"));

    expect(reassembler.consume(first)).toBeUndefined();
    expect(reassembler.consume(first)).toBeUndefined();
    const complete = reassembler.consume(second);

    expect(complete?.packet.payload.toString()).toBe("firstsecond");
    expect(complete?.packet.fragmented).toBe(false);
    expect(reassembled).toBe(1);
  });
});

function fragmentPacket(id: number, part: number, total: number, payload: Buffer): CapturedLiteNetLibPacket {
  return {
    mergePath: [],
    packet: {
      propertyId: 1,
      property: "channeled",
      connectionNumber: 0,
      fragmented: true,
      sequence: part + 10,
      channel: 0,
      fragment: { id, part, total },
      raw: payload,
      payload,
    },
    udpPacket: {
      protocol: "udp",
      timestampTicks: 0n,
      capturedAt: new Date(0),
      interfaceIndex: 0,
      subinterfaceIndex: 0,
      direction: "inbound",
      loopback: false,
      ipVersion: 4,
      sourceIP: "203.0.113.10",
      destinationIP: "192.0.2.5",
      sourcePort: 7000,
      destinationPort: 6000,
      truncated: false,
      payload,
    },
  };
}
