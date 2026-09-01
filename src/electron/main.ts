import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import { parseCollectorMessage } from "../shared/collector-protocol.ts";
import { createDiagnosticLogger, formatError } from "../shared/diagnostics.ts";

const COLLECTOR_START_TIMEOUT_MS = 20_000;
let collector: ChildProcessWithoutNullStreams | undefined;
let mainWindow: BrowserWindow | undefined;
let quitAfterCollectorStops = false;
let collectorStopping = false;
let collectorReady = false;
let diagnostics = createDiagnosticLogger("desktop");

app.setName("ValeLoot Desktop");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    diagnostics.info("Second-instance launch redirected to the existing window");
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    diagnostics.info("Electron ready", { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch, pid: process.pid });
    try {
      const port = await startCollector();
      createMainWindow(port);
    } catch (error) {
      diagnostics.error("Desktop startup failed", { error: formatError(error) });
      await stopCollector();
      dialog.showErrorBox("ValeLoot collector could not start", error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
}

app.on("window-all-closed", () => {
  diagnostics.info("All desktop windows closed");
  app.quit();
});
app.on("before-quit", (event) => {
  diagnostics.debug("Before-quit received", { collectorRunning: Boolean(collector), collectorStopping, quitAfterCollectorStops });
  if (quitAfterCollectorStops || !collector) return;
  event.preventDefault();
  void stopCollector().then(() => {
    quitAfterCollectorStops = true;
    diagnostics.info("Collector stopped; completing desktop shutdown");
    app.quit();
  });
});
process.on("uncaughtException", (error) => diagnostics.error("Uncaught desktop exception", { error: formatError(error) }));
process.on("unhandledRejection", (error) => diagnostics.error("Unhandled desktop rejection", { error: formatError(error) }));

async function startCollector(): Promise<number> {
  collectorReady = false;
  collectorStopping = false;
  const paths = runtimePaths();
  diagnostics = createDiagnosticLogger("desktop", path.join(paths.data, "logs", "desktop.log"));
  diagnostics.info("Resolved desktop runtime paths", { ...paths });
  if (!existsSync(paths.runtime)) throw new Error(`Bun collector runtime is missing: ${paths.runtime}`);
  if (!existsSync(paths.entrypoint)) throw new Error(`Collector entrypoint is missing: ${paths.entrypoint}`);
  if (!existsSync(paths.renderer)) throw new Error(`Desktop renderer is missing: ${paths.renderer}`);

  collector = spawn(paths.runtime, [paths.entrypoint], {
    cwd: paths.collector,
    env: {
      ...process.env,
      VALELOOT_APP_ROOT: paths.installRoot,
      VALELOOT_DATA_DIR: paths.data,
      VALELOOT_RENDERER_DIR: paths.renderer,
      VALELOOT_VERSION: app.getVersion(),
      VALELOOT_LOG_FILE: path.join(paths.data, "logs", "collector.log"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  diagnostics.info("Collector process spawned", { pid: collector.pid, runtime: paths.runtime, entrypoint: paths.entrypoint });
  collector.stderr.setEncoding("utf8");
  collector.stderr.on("data", (chunk: string) => {
    if (chunk.trim()) diagnostics.debug("Collector diagnostic output", { output: chunk.trimEnd() });
  });

  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error("The collector did not report ready within 20 seconds.");
      diagnostics.error("Collector startup timed out", { error: error.message });
      reject(error);
    }, COLLECTOR_START_TIMEOUT_MS);
    const lines = createInterface({ input: collector!.stdout });
    lines.on("line", (line) => {
      const message = parseCollectorMessage(line);
      if (!message) {
        if (line.trim()) diagnostics.warn("Collector emitted an unrecognized protocol line", { line });
        return;
      }
      if (message.type === "ready") {
        collectorReady = true;
        clearTimeout(timeout);
        diagnostics.info("Collector reported ready", { port: message.port });
        resolve(message.port);
      } else if (message.type === "play-sound") {
        diagnostics.debug("Forwarding collector sound alert", { name: message.name, windowAvailable: Boolean(mainWindow) });
        mainWindow?.webContents.send("valeLoot:play-sound", message.name);
      }
    });
    collector!.once("error", (error) => {
      clearTimeout(timeout);
      diagnostics.error("Collector process error", { error: formatError(error) });
      reject(error);
    });
    collector!.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const expected = collectorStopping || quitAfterCollectorStops;
      diagnostics.info("Collector process exited", { code, signal, expected, ready: collectorReady });
      collector = undefined;
      if (!collectorReady) reject(new Error(`Collector exited before startup (${signal ?? code ?? "unknown"}).`));
      else if (!expected) {
        dialog.showErrorBox("ValeLoot collector stopped", `The capture collector exited unexpectedly (${signal ?? code ?? "unknown"}).`);
        app.quit();
      }
    });
  });
}

function createMainWindow(port: number): void {
  mainWindow = new BrowserWindow({
    title: "ValeLoot Desktop",
    width: 1_280,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: "#111418",
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const applicationUrl = `http://127.0.0.1:${port}/`;
  diagnostics.info("Desktop window created", { port, url: applicationUrl });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    diagnostics.warn("Blocked renderer window request", { url });
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === applicationUrl) return;
    diagnostics.warn("Blocked renderer navigation", { url });
    event.preventDefault();
  });
  mainWindow.webContents.on("did-finish-load", () => diagnostics.info("Renderer finished loading", { url: applicationUrl }));
  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    diagnostics.error("Renderer failed to load", { code, description, url: validatedUrl });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => diagnostics.error("Renderer process exited", { details }));
  mainWindow.on("unresponsive", () => diagnostics.warn("Desktop window became unresponsive"));
  mainWindow.once("ready-to-show", () => {
    diagnostics.info("Desktop window ready to show");
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    diagnostics.info("Desktop window closed");
    mainWindow = undefined;
  });
  void mainWindow.loadURL(applicationUrl).catch((error) => diagnostics.error("Renderer URL load rejected", { error: formatError(error) }));
}

async function stopCollector(): Promise<void> {
  const child = collector;
  if (!child) return;
  collectorStopping = true;
  diagnostics.info("Stopping collector", { pid: child.pid });
  child.stdin.end();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      diagnostics.warn("Collector did not stop within two seconds; killing process", { pid: child.pid });
      child.kill();
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      diagnostics.debug("Collector acknowledged shutdown", { pid: child.pid });
      resolve();
    });
  });
}

interface RuntimePaths {
  collector: string;
  runtime: string;
  entrypoint: string;
  renderer: string;
  installRoot: string;
  data: string;
}

function runtimePaths(): RuntimePaths {
  const developmentRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const collectorDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "collector")
    : path.join(developmentRoot, "build", "collector");
  const rendererDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "renderer")
    : path.join(developmentRoot, "build", "renderer");
  const executableDirectory = process.env.PORTABLE_EXECUTABLE_DIR
    ?? (process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : path.dirname(app.getPath("exe")));
  const portable = existsSync(path.join(executableDirectory, ".valeloot-portable"));
  return {
    collector: collectorDirectory,
    runtime: path.join(collectorDirectory, "bin", process.platform === "win32" ? "bun.exe" : "bun"),
    entrypoint: path.join(collectorDirectory, "index.js"),
    renderer: rendererDirectory,
    installRoot: executableDirectory,
    data: portable ? path.join(executableDirectory, "data") : app.getPath("userData"),
  };
}
