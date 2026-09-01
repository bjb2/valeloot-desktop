export type CollectorMessage =
  | { type: "ready"; port: number }
  | { type: "play-sound"; name: string };

export function parseCollectorMessage(line: string): CollectorMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === "ready" && Number.isInteger(message.port) && Number(message.port) > 0 && Number(message.port) <= 65_535) {
    return { type: "ready", port: Number(message.port) };
  }
  if (message.type === "play-sound" && typeof message.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(message.name)) {
    return { type: "play-sound", name: message.name };
  }
  return undefined;
}

export function serializeCollectorMessage(message: CollectorMessage): string {
  return `${JSON.stringify(message)}\n`;
}
