import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const build = path.join(root, "build");
const rendererOutput = path.join(build, "renderer");
const collectorOutput = path.join(build, "collector");
const electronOutput = path.join(build, "electron");
const runtimeOutput = path.join(collectorOutput, "bin", process.platform === "win32" ? "bun.exe" : "bun");

await Promise.all([
  rm(build, { recursive: true, force: true }),
  rm(path.join(root, "resources"), { recursive: true, force: true }),
  rm(path.join(root, "extensions"), { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(rendererOutput, { recursive: true }),
  mkdir(collectorOutput, { recursive: true }),
  mkdir(electronOutput, { recursive: true }),
  mkdir(path.dirname(runtimeOutput), { recursive: true }),
]);

await Promise.all([
  bundle(path.join(root, "src", "frontend", "index.tsx"), rendererOutput, "browser", "esm", "index.[ext]"),
  bundle(path.join(root, "src", "backend", "index.ts"), collectorOutput, "bun", "esm", "index.[ext]"),
  bundle(path.join(root, "src", "electron", "main.ts"), electronOutput, "node", "esm", "main.[ext]", ["electron"]),
  bundle(path.join(root, "src", "electron", "preload.ts"), electronOutput, "node", "cjs", "preload.cjs", ["electron"]),
]);

await Promise.all([
  copyFile(path.join(root, "src", "frontend", "index.html"), path.join(rendererOutput, "index.html")),
  copyFile(path.join(root, "src", "frontend", "index.css"), path.join(rendererOutput, "index.css")),
  copyFile(path.join(root, "assets", "catalog.json"), path.join(collectorOutput, "catalog.json")),
  copyFile(path.join(root, "docs", "starter-ruleset.txt"), path.join(collectorOutput, "starter-ruleset.txt")),
  cp(path.join(root, "assets", "icons"), path.join(collectorOutput, "icons"), { recursive: true }),
  copyFile(process.execPath, runtimeOutput),
]);
if (process.platform !== "win32") await chmod(runtimeOutput, 0o755);

console.log(`ValeLoot Electron application prepared in ${build}`);

async function bundle(
  entrypoint: string,
  outdir: string,
  target: "browser" | "bun" | "node",
  format: "esm" | "cjs",
  naming: string,
  external: string[] = [],
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target,
    format,
    external,
    minify: false,
    sourcemap: "external",
    naming,
  });
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entrypoint}`);
}
