import type { CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import { decodeCharacterData, identifyCharacterPayload } from "./character-data.ts";
import type { SaviSnapshot } from "./types.ts";

const characterRpcNames: Readonly<Record<string, true>> = { LoadCharacter_T: true, CharacterCallback_T: true };
export interface PacketConsumerResult { snapshot?: SaviSnapshot; ignored: boolean; }
/** PacketCapture owns LiteNetLib fragmentation and FishNet split reassembly before this boundary. */
export function consumeFishNetPacket(packet: CapturedFishNetPacket): PacketConsumerResult {
  if (packet.liteNetPacket.udpPacket.direction === "outbound") return { ignored: true };
  if (packet.rpcName && characterRpcNames[packet.rpcName]) {
    try {
      return {
        snapshot: decodeCharacterData(packet.payload, { includesUpdateType: packet.rpcName === "CharacterCallback_T" }),
        ignored: false,
      };
    } catch {
      return { ignored: true };
    }
  }
  if (packet.rpcName) return { ignored: true };
  const snapshot = identifyCharacterPayload(packet.payload);
  return snapshot ? { snapshot, ignored: false } : { ignored: true };
}
