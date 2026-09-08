import type { PrinterStatus } from "../shared/types";

type PrinterData = {
  status?: unknown;
  options?: Record<string, unknown>;
};

function reportedStatus(printer: PrinterData): unknown {
  return (
    printer.status ??
    printer.options?.["printer-state"] ??
    printer.options?.["printer-status"] ??
    printer.options?.status
  );
}

export function printerStatus(
  printer: PrinterData,
  platform: NodeJS.Platform = process.platform,
): PrinterStatus {
  const reported = reportedStatus(printer);

  if (typeof reported === "string" && !/^\d+$/.test(reported.trim())) {
    const normalized = reported.trim().toLowerCase();
    if (["idle", "processing", "online", "ready"].includes(normalized)) {
      return "online";
    }
    if (["offline", "paused", "stopped"].includes(normalized)) {
      return "offline";
    }
    if (normalized.includes("error")) return "error";
  }

  const value =
    typeof reported === "number" ? reported : Number(String(reported ?? ""));

  if (Number.isFinite(value)) {
    if (platform === "win32") {
      if (value === 0) return "online";

      const offlineFlags = 0x1 | 0x80 | 0x1000 | 0x2000000;
      if ((value & offlineFlags) !== 0) return "offline";

      const errorFlags =
        0x2 |
        0x8 |
        0x10 |
        0x40 |
        0x800 |
        0x40000 |
        0x100000 |
        0x200000 |
        0x400000;
      if ((value & errorFlags) !== 0) return "error";

      return "online";
    }

    // CUPS reports 3 for idle, 4 for processing, and 5 for stopped.
    if (value === 3 || value === 4 || value === 0) return "online";
    if (value === 5) return "offline";
    if (value < 0) return "error";
  }

  // Some drivers omit status data even though the printer is available to
  // Chromium. Printing remains the authoritative availability check.
  return "online";
}
