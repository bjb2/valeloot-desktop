import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalSoundName, findCustomSound, listCustomSounds } from "../src/backend/sounds.ts";

const directory = mkdtempSync(path.join(tmpdir(), "valeloot-sounds-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("custom WAV discovery is safe, extension-agnostic, and reserves built-ins", () => {
  writeFileSync(path.join(directory, "raid-horn.wav"), "RIFF");
  writeFileSync(path.join(directory, "foo.wav.wav"), "RIFF");
  writeFileSync(path.join(directory, "alert.wav"), "RIFF");
  writeFileSync(path.join(directory, "bad name.wav"), "RIFF");
  writeFileSync(path.join(directory, "notes.txt"), "not audio");

  expect(listCustomSounds(directory).map((sound) => sound.name)).toEqual(["foo.wav", "raid-horn"]);
  expect(findCustomSound(directory, "RAID-HORN")?.name).toBe("raid-horn");
  expect(findCustomSound(directory, canonicalSoundName("raid-horn.wav"))?.name).toBe("raid-horn");
  expect(findCustomSound(directory, canonicalSoundName("foo.wav.wav"))?.name).toBe("foo.wav");
  expect(canonicalSoundName("../../secret.wav")).toBeNull();
});
