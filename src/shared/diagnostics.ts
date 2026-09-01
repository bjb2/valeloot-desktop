import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type DiagnosticContext = Readonly<Record<string, unknown>>;

export interface DiagnosticLogger {
  debug(message: string, context?: DiagnosticContext): void;
  info(message: string, context?: DiagnosticContext): void;
  warn(message: string, context?: DiagnosticContext): void;
  error(message: string, context?: DiagnosticContext): void;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function createDiagnosticLogger(component: string, filePath?: string): DiagnosticLogger {
  let currentBytes = filePath ? prepareLogFile(filePath) : 0;
  const write = (level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, context?: DiagnosticContext) => {
    const suffix = context ? ` ${stringifyContext(context)}` : "";
    const line = `${new Date().toISOString()} [${level}] [${component}] ${message}${suffix}\n`;
    process.stderr.write(line);
    if (!filePath) return;
    try {
      const lineBytes = Buffer.byteLength(line);
      if (currentBytes + lineBytes > MAX_LOG_BYTES) {
        rotateLogFile(filePath);
        currentBytes = 0;
      }
      appendFileSync(filePath, line, "utf8");
      currentBytes += lineBytes;
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} [ERROR] [${component}] Could not write diagnostic log: ${formatError(error)}\n`);
    }
  };
  return {
    debug: (message, context) => write("DEBUG", message, context),
    info: (message, context) => write("INFO", message, context),
    warn: (message, context) => write("WARN", message, context),
    error: (message, context) => write("ERROR", message, context),
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function prepareLogFile(filePath: string): number {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const size = statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
    if (size < MAX_LOG_BYTES) return size;
    rotateLogFile(filePath);
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} [ERROR] [diagnostics] Could not prepare ${filePath}: ${formatError(error)}\n`);
  }
  return 0;
}

function rotateLogFile(filePath: string): void {
  const previous = `${filePath}.1`;
  rmSync(previous, { force: true });
  renameSync(filePath, previous);
}

function stringifyContext(context: DiagnosticContext): string {
  try {
    return JSON.stringify(context, (_key, value: unknown) => {
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      return value;
    });
  } catch (error) {
    return JSON.stringify({ contextSerializationError: formatError(error) });
  }
}
