import { appendFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const REDACTED_KEYS = new Set([
  "authorization",
  "token",
  "lease_token",
  "pairing_code",
  "pairingCode",
  "pdf",
  "content",
  "contentBody",
  "customer",
  "customerName",
  "response",
  "responseBody",
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        REDACTED_KEYS.has(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/lbp_[A-Za-z0-9._-]+/g, "[REDACTED]");
  }
  return value;
}

export class StructuredLogger {
  constructor(private readonly filePath: string) {}

  async log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(
      redact({ timestamp: new Date().toISOString(), level, event, ...fields }),
    );
    await appendFile(this.filePath, `${line}\n`, { mode: 0o600 });
  }

  async exportTo(destination: string): Promise<void> {
    await copyFile(this.filePath, destination);
  }
}
