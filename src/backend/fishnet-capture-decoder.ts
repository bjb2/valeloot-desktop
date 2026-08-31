import {
  FishNetProtocolError,
  FishNetSessionDecoder,
  loadBundledFishNetRpcMap,
  type CapturedFishNetPacket,
  type CapturedLiteNetLibPacket,
  type LiteNetLibChanneledPacket,
} from "@kar-mi/spirit-vale-tools-capture";

const MAX_FRAGMENT_GROUPS = 64;
const MAX_FRAGMENT_PARTS = 1_024;
const MAX_FRAGMENT_BYTES = 1024 * 1024;
const FRAGMENT_MAX_AGE_MS = 10_000;

interface FragmentGroup {
  connectionId: string;
  total: number;
  parts: Array<Buffer | undefined>;
  packets: Array<CapturedLiteNetLibPacket | undefined>;
  received: number;
  bytes: number;
  lastSeenAt: number;
}

export interface FishNetCaptureDecoderCallbacks {
  onPacket: (packet: CapturedFishNetPacket) => void;
  onWarning: (message: string) => void;
  onFragmentReassembled?: () => void;
  onFragmentDropped?: () => void;
}

/** Restores LiteNetLib's message boundary before passing payloads to FishNet. */
export class FishNetCaptureDecoder {
  private readonly fishNetRpcMap = loadBundledFishNetRpcMap();
  private readonly fishNet = new FishNetSessionDecoder(this.fishNetRpcMap);
  private readonly fragments: LiteNetFragmentReassembler;

  constructor(private readonly callbacks: FishNetCaptureDecoderCallbacks, now: () => number = Date.now) {
    this.fragments = new LiteNetFragmentReassembler(
      now,
      () => this.callbacks.onFragmentReassembled?.(),
      () => this.callbacks.onFragmentDropped?.(),
    );
  }

  consume(packet: CapturedLiteNetLibPacket): void {
    const { property } = packet.packet;
    const connectionId = connectionIdFor(packet);
    if (property === "connectRequest" || property === "connectAccept" || property === "disconnect") {
      this.fishNet.reset(connectionId);
      this.fragments.reset(connectionId);
      return;
    }

    const complete = this.fragments.consume(packet, connectionId);
    if (complete === undefined) return;
    const { payload } = complete.packet;
    if ((complete.packet.property !== "unreliable" && complete.packet.property !== "channeled") || payload.length < 6) return;

    try {
      const decoded = this.fishNet.decode(payload, {
        reliable: complete.packet.property === "channeled",
        rpcMap: this.fishNetRpcMap,
        connectionId,
        direction: complete.udpPacket.direction,
        channel: complete.packet.property === "channeled" ? complete.packet.channel : 1,
        ...(complete.packet.property === "channeled" ? { sequence: complete.packet.sequence } : {}),
      });
      for (const fishNetPacket of decoded) {
        this.callbacks.onPacket({ ...fishNetPacket, liteNetPacket: complete, connectionId });
      }
    } catch (error) {
      const detail = error instanceof FishNetProtocolError ? error.message : errorMessage(error);
      this.callbacks.onWarning(`skipped FishNet decode at LiteNetLib path ${complete.mergePath.join(".") || "root"}: ${detail}`);
    }
  }

  reset(): void {
    this.fishNet.reset();
    this.fragments.reset();
  }
}

export class LiteNetFragmentReassembler {
  private readonly groups = new Map<string, FragmentGroup>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onReassembled: () => void = () => {},
    private readonly onDropped: () => void = () => {},
  ) {}

  consume(packet: CapturedLiteNetLibPacket, connectionId = connectionIdFor(packet)): CapturedLiteNetLibPacket | undefined {
    this.expire();
    if (packet.packet.property !== "channeled" || packet.packet.fragment === undefined) return packet;

    const fragment = packet.packet.fragment;
    if (fragment.total < 1 || fragment.total > MAX_FRAGMENT_PARTS || fragment.part >= fragment.total) {
      this.onDropped();
      return undefined;
    }

    const key = fragmentKey(packet, connectionId);
    let group = this.groups.get(key);
    if (group !== undefined && group.total !== fragment.total) {
      this.drop(key);
      group = undefined;
    }
    if (group === undefined) {
      if (this.groups.size >= MAX_FRAGMENT_GROUPS) this.dropOldest();
      group = {
        connectionId,
        total: fragment.total,
        parts: new Array<Buffer | undefined>(fragment.total),
        packets: new Array<CapturedLiteNetLibPacket | undefined>(fragment.total),
        received: 0,
        bytes: 0,
        lastSeenAt: this.now(),
      };
      this.groups.set(key, group);
    }

    const previous = group.parts[fragment.part];
    if (previous !== undefined) {
      if (previous.equals(packet.packet.payload)) group.lastSeenAt = this.now();
      else {
        this.drop(key);
        return this.consume(packet, connectionId);
      }
      return undefined;
    }

    group.parts[fragment.part] = packet.packet.payload;
    group.packets[fragment.part] = packet;
    group.received += 1;
    group.bytes += packet.packet.payload.length;
    group.lastSeenAt = this.now();
    if (group.bytes > MAX_FRAGMENT_BYTES) {
      this.drop(key);
      return undefined;
    }
    if (group.received < group.total) return undefined;

    this.groups.delete(key);
    const first = group.packets[0] ?? packet;
    const payload = Buffer.concat(group.parts as Buffer[], group.bytes);
    const channeled = first.packet as LiteNetLibChanneledPacket;
    const { fragment: _fragment, ...withoutFragment } = channeled;
    this.onReassembled();
    return {
      ...first,
      packet: {
        ...withoutFragment,
        fragmented: false,
        payload,
        raw: payload,
      },
    };
  }

  reset(connectionId?: string): void {
    if (connectionId === undefined) {
      this.groups.clear();
      return;
    }
    for (const [key, group] of this.groups) {
      if (group.connectionId === connectionId) this.groups.delete(key);
    }
  }

  private expire(): void {
    const cutoff = this.now() - FRAGMENT_MAX_AGE_MS;
    for (const [key, group] of this.groups) {
      if (group.lastSeenAt < cutoff) this.drop(key);
    }
  }

  private dropOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, group] of this.groups) {
      if (group.lastSeenAt < oldestAt) {
        oldestAt = group.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.drop(oldestKey);
  }

  private drop(key: string): void {
    if (this.groups.delete(key)) this.onDropped();
  }
}

function fragmentKey(packet: CapturedLiteNetLibPacket, connectionId: string): string {
  if (packet.packet.property !== "channeled" || packet.packet.fragment === undefined) return connectionId;
  return [
    connectionId,
    packet.udpPacket.direction,
    packet.packet.channel,
    packet.packet.fragment.id,
    packet.mergePath.join("."),
  ].join("|");
}

function connectionIdFor(packet: CapturedLiteNetLibPacket): string {
  const udp = packet.udpPacket;
  const localPort = udp.direction === "outbound" ? udp.sourcePort : udp.destinationPort;
  return `local:${localPort}#${packet.packet.connectionNumber}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
