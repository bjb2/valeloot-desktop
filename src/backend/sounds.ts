import { readdirSync } from "node:fs";
import path from "node:path";
import { normalizeSoundName } from "../core/filter/loot-filter.ts";

const toneFrequencies: Readonly<Record<string, readonly [number, number]>> = {
  blip: [620, 820],
  chime: [523, 784],
  ding: [880, 1175],
  alert: [440, 660],
  thud: [150, 110],
};

export const SOUND_NAMES = Object.freeze(Object.keys(toneFrequencies));
export const SOUND_WAVS: Readonly<Record<string, Uint8Array>> = Object.freeze(
  Object.fromEntries(Object.entries(toneFrequencies).map(([name, frequencies]) => [name, synthesizeTone(frequencies)])),
);

export interface CustomSoundFile {
  name: string;
  path: string;
}

export function canonicalSoundName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  return normalizeSoundName(input.replace(/\.wav$/i, ""));
}

export function listCustomSounds(directory: string): CustomSoundFile[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const reserved = new Set(SOUND_NAMES.map((name) => name.toLowerCase()));
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => {
      const name = normalizeSoundName(entry.name.slice(0, -4));
      return name ? { name, path: path.join(directory, entry.name) } : null;
    })
    .filter((entry): entry is CustomSoundFile => entry !== null && !reserved.has(entry.name.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function findCustomSound(directory: string, input: unknown): CustomSoundFile | null {
  const wanted = normalizeSoundName(input)?.toLowerCase();
  return wanted ? listCustomSounds(directory).find((entry) => entry.name.toLowerCase() === wanted) ?? null : null;
}

function synthesizeTone([firstFrequency, secondFrequency]: readonly [number, number]): Uint8Array {
  const sampleRate = 22_050;
  const durationSeconds = 0.24;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);

  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < sampleCount; index++) {
    const seconds = index / sampleRate;
    const progress = index / sampleCount;
    const attack = Math.min(1, progress / 0.06);
    const release = Math.min(1, (1 - progress) / 0.28);
    const envelope = attack * release;
    const frequency = progress < 0.48 ? firstFrequency : secondFrequency;
    const harmonic = Math.sin(2 * Math.PI * frequency * seconds)
      + 0.18 * Math.sin(4 * Math.PI * frequency * seconds);
    view.setInt16(44 + index * 2, Math.round(harmonic * envelope * 9_000), true);
  }
  return bytes;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) target[offset + index] = value.charCodeAt(index);
}
