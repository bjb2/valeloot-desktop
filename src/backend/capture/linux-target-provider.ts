import { readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import type { CaptureProtocol } from "@kar-mi/spirit-vale-tools-capture";

export interface OwnedEndpoint {
  protocol: CaptureProtocol;
  address: string;
  port: number;
  processId: number;
}

export class LinuxTargetSnapshotProvider {
  constructor(private readonly procRoot = "/proc") {}

  async snapshot(processName: string, protocols: readonly CaptureProtocol[]): Promise<{ processIds: number[]; endpoints: OwnedEndpoint[] }> {
    const processIds = await this.findProcessIds(processName);
    if (processIds.length === 0) return { processIds, endpoints: [] };

    const endpoints = (await Promise.all(processIds.map(async (processId) => {
      const inodes = await this.socketInodes(processId);
      if (inodes.size === 0) return [];
      return this.readEndpoints(processId, protocols, inodes);
    }))).flat();

    return { processIds, endpoints };
  }

  private async findProcessIds(processName: string): Promise<number[]> {
    const entries = await readdir(this.procRoot, { withFileTypes: true });
    const matches = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const processId = Number(entry.name);
        try {
          const [comm, commandLine] = await Promise.all([
            readFile(path.join(this.procRoot, entry.name, "comm"), "utf8"),
            readFile(path.join(this.procRoot, entry.name, "cmdline"), "utf8"),
          ]);
          return matchesLinuxProcessName(processName, comm, commandLine) ? processId : undefined;
        } catch {
          return undefined;
        }
      }));
    return matches.filter((processId): processId is number => processId !== undefined).sort((left, right) => left - right);
  }

  private async socketInodes(processId: number): Promise<Set<string>> {
    const directory = path.join(this.procRoot, String(processId), "fd");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return new Set();
    }
    const links = await Promise.all(entries.map(async (entry) => {
      try {
        return await readlink(path.join(directory, entry.name));
      } catch {
        return "";
      }
    }));
    return new Set(links.map((link) => /^socket:\[(\d+)]$/.exec(link)?.[1]).filter((inode): inode is string => Boolean(inode)));
  }

  private async readEndpoints(processId: number, protocols: readonly CaptureProtocol[], inodes: ReadonlySet<string>): Promise<OwnedEndpoint[]> {
    const selected = new Set(protocols);
    const tables = [
      ...(selected.has("tcp") ? [{ protocol: "tcp" as const, ipv6: false, file: "tcp" }, { protocol: "tcp" as const, ipv6: true, file: "tcp6" }] : []),
      ...(selected.has("udp") ? [{ protocol: "udp" as const, ipv6: false, file: "udp" }, { protocol: "udp" as const, ipv6: true, file: "udp6" }] : []),
    ];
    const results = await Promise.all(tables.map(async (table) => {
      try {
        const text = await readFile(path.join(this.procRoot, String(processId), "net", table.file), "utf8");
        return parseProcNetTable(table.protocol, table.ipv6, text, processId, inodes);
      } catch {
        return [];
      }
    }));
    const unique = new Map<string, OwnedEndpoint>();
    for (const endpoint of results.flat()) unique.set(`${endpoint.protocol}|${endpoint.address}|${endpoint.port}|${endpoint.processId}`, endpoint);
    return [...unique.values()];
  }
}

export function matchesLinuxProcessName(processName: string, comm: string, commandLine: string): boolean {
  const target = normalizedExecutableName(processName);
  if (!target) return false;
  const candidates = [comm.trim(), ...commandLine.split("\0").filter(Boolean)];
  return candidates.some((candidate) => normalizedExecutableName(candidate) === target);
}

export function parseProcNetTable(
  protocol: CaptureProtocol,
  ipv6: boolean,
  text: string,
  processId: number,
  inodes: ReadonlySet<string>,
): OwnedEndpoint[] {
  const endpoints: OwnedEndpoint[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10 || !inodes.has(columns[9]!)) continue;
    const [addressHex, portHex] = columns[1]!.split(":");
    if (!addressHex || !portHex) continue;
    const address = ipv6 ? decodeProcIpv6(addressHex) : decodeProcIpv4(addressHex);
    const port = Number.parseInt(portHex, 16);
    if (!address || !Number.isInteger(port) || port < 0 || port > 65_535) continue;
    endpoints.push({ protocol, address, port, processId });
  }
  return endpoints;
}

function normalizedExecutableName(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.toLocaleLowerCase();
}

function decodeProcIpv4(value: string): string | undefined {
  if (!/^[0-9A-Fa-f]{8}$/.test(value)) return undefined;
  const bytes = value.match(/../g);
  return bytes ? bytes.reverse().map((byte) => Number.parseInt(byte, 16)).join(".") : undefined;
}

function decodeProcIpv6(value: string): string | undefined {
  if (!/^[0-9A-Fa-f]{32}$/.test(value)) return undefined;
  const bytes: number[] = [];
  for (let offset = 0; offset < value.length; offset += 8) {
    const word = value.slice(offset, offset + 8).match(/../g);
    if (!word) return undefined;
    bytes.push(...word.reverse().map((byte) => Number.parseInt(byte, 16)));
  }
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === "0") end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestLength < 2) return groups.join(":");
  const before = groups.slice(0, bestStart).join(":");
  const after = groups.slice(bestStart + bestLength).join(":");
  if (!before && !after) return "::";
  if (!before) return `::${after}`;
  if (!after) return `${before}::`;
  return `${before}::${after}`;
}
