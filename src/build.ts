import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("ValeLoot Desktop packaging is supported on Windows only.");
}

const root = path.resolve(import.meta.dir, "..");
const resources = path.join(root, "resources");
const viewOutput = path.join(resources, "views", "main");
const extensionOutput = path.join(root, "extensions", "backend");
const binaryOutput = path.join(root, "extensions", "bin");

await Promise.all([
  rm(resources, { recursive: true, force: true }),
  rm(path.join(root, "extensions"), { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(viewOutput, { recursive: true }),
  mkdir(extensionOutput, { recursive: true }),
  mkdir(binaryOutput, { recursive: true }),
]);

await Promise.all([
  bundleBrowser(path.join(root, "src", "frontend", "index.tsx"), viewOutput),
  bundleBackend(path.join(root, "src", "backend", "index.ts"), extensionOutput),
]);

await Promise.all([
  copyFile(path.join(root, "src", "frontend", "index.html"), path.join(viewOutput, "index.html")),
  copyFile(path.join(root, "src", "frontend", "index.css"), path.join(viewOutput, "index.css")),
  copyFile(path.join(root, "assets", "catalog.json"), path.join(extensionOutput, "catalog.json")),
  cp(path.join(root, "assets", "icons"), path.join(extensionOutput, "icons"), { recursive: true }),
  copyFile(process.execPath, path.join(binaryOutput, "bun.exe")),
]);

console.log(`ValeLoot Desktop prepared in ${root}`);

async function bundleBrowser(entrypoint: string, outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "external",
    naming: "index.[ext]",
  });
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entrypoint}`);
}

async function bundleBackend(entrypoint: string, outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "external",
    naming: "index.[ext]",
  });
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entrypoint}`);
}
