import type { CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import { decodeCharacterData, decodePersonalStorageBatchPayload, identifyCharacterPayload } from "./character-data.ts";
import type { SaviInventory, SaviSnapshot } from "./types.ts";

const characterRpcNames: Readonly<Record<string, true>> = { LoadCharacter_T: true, CharacterCallback_T: true };
const personalStorageRpcNames: Readonly<Record<string, true>> = {
  CompletePersonalStorageBatch: true,
  PlayerCallback_Storage: true,
};
export interface PacketConsumerResult { snapshot?: SaviSnapshot; inventory?: SaviInventory; ignored: boolean; }
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
  if (packet.rpcName && personalStorageRpcNames[packet.rpcName]) {
    const inventory = decodePersonalStorageBatchPayload(packet.payload);
    return inventory ? { inventory, ignored: false } : { ignored: true };
  }
  if (packet.rpcName) return { ignored: true };
  const snapshot = identifyCharacterPayload(packet.payload);
  if (snapshot) return { snapshot, ignored: false };
  const inventory = decodePersonalStorageBatchPayload(packet.payload);
  return inventory ? { inventory, ignored: false } : { ignored: true };
}
