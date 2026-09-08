import {
  BrowserWindow,
  type PrinterInfo as ElectronPrinterInfo,
  type WebContentsPrintOptions,
} from "electron";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  print as printPdfWithSumatra,
  type PrintOptions as SumatraPrintOptions,
} from "pdf-to-printer";
import type { PrintOptions, PrinterInfo } from "../shared/types";
import {
  PrintFailure,
  type PrintAdapter,
  type PrintResult,
} from "./print-contract";
import { printerStatus } from "./printer-status";

const CSS_PIXELS_PER_INCH = 96;
const MILLIMETERS_PER_INCH = 25.4;
export const SUMATRA_EXECUTABLE = "SumatraPDF-3.4.6-32.exe";

export type NativePdfPrint = (
  filePath: string,
  options: SumatraPrintOptions,
) => Promise<void>;

export interface NativeHelperLocation {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

interface ElectronPrintAdapterOptions {
  platform?: NodeJS.Platform;
  helperPath?: string;
  nativePdfPrint?: NativePdfPrint;
}

export function resolveNativeHelperPath({
  isPackaged,
  resourcesPath,
  appPath,
}: NativeHelperLocation): string {
  return isPackaged
    ? path.join(resourcesPath, SUMATRA_EXECUTABLE)
    : path.join(
        appPath,
        "node_modules",
        "pdf-to-printer",
        "dist",
        SUMATRA_EXECUTABLE,
      );
}

export function millimetersToCssPixels(millimeters: number): number {
  return (millimeters * CSS_PIXELS_PER_INCH) / MILLIMETERS_PER_INCH;
}

export function createHtmlPrintOptions(
  printerName: string,
  options: PrintOptions,
): WebContentsPrintOptions {
  const margin = millimetersToCssPixels(options.margin_mm);

  return {
    silent: true,
    printBackground: false,
    deviceName: printerName,
    copies: options.copies,
    landscape: options.orientation === "landscape",
    ...(options.dpi
      ? { dpi: { horizontal: options.dpi, vertical: options.dpi } }
      : {}),
    margins: {
      marginType: "custom",
      top: margin,
      bottom: margin,
      left: margin,
      right: margin,
    },
    pageSize: {
      width: Math.round(options.paper_width_mm * 1_000),
      height: Math.round(options.paper_height_mm * 1_000),
    },
  };
}

async function validatePdf(filePath: string): Promise<void> {
  let file;
  try {
    file = await open(filePath, "r");
    const start = Buffer.alloc(1_024);
    const { bytesRead } = await file.read(start, 0, start.length, 0);
    if (!/%PDF-\d\.\d/.test(start.subarray(0, bytesRead).toString("latin1"))) {
      throw new PrintFailure(
        "The print file is not a valid PDF.",
        "invalid_pdf",
        false,
      );
    }
  } catch (error) {
    if (error instanceof PrintFailure) throw error;
    throw new PrintFailure(
      "The PDF file is missing or cannot be read.",
      "invalid_pdf",
      false,
    );
  } finally {
    await file?.close();
  }
}

function nativeFailureMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return "The native PDF printer rejected the job.";
  }
  return `The native PDF printer failed: ${error.message}`;
}

export class ElectronPrintAdapter implements PrintAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly helperPath: string;
  private readonly nativePdfPrint: NativePdfPrint;

  constructor(
    private readonly testPagePath: string,
    options: ElectronPrintAdapterOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.helperPath =
      options.helperPath ??
      resolveNativeHelperPath({
        isPackaged: false,
        resourcesPath: process.resourcesPath,
        appPath: process.cwd(),
      });
    this.nativePdfPrint = options.nativePdfPrint ?? printPdfWithSumatra;
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    const owner = BrowserWindow.getAllWindows()[0];
    if (!owner) return [];
    return (await owner.webContents.getPrintersAsync()).map((printer) => ({
      name: printer.name,
      displayName: printer.displayName,
      status: printerStatus(
        {
          status: (printer as ElectronPrinterInfo & { status?: number }).status,
          options: printer.options as unknown as Record<string, unknown>,
        },
        this.platform,
      ),
      isDefault:
        (printer.options as unknown as Record<string, string>).isDefault ===
        "true",
    }));
  }

  async printPdf(
    filePath: string,
    printerName: string,
    options: PrintOptions,
  ): Promise<PrintResult> {
    await this.requireAvailablePrinter(printerName);
    if (this.platform !== "win32") {
      throw new PrintFailure(
        "Native PDF printing is only supported on Windows.",
        "unsupported_platform",
        false,
      );
    }
    await validatePdf(filePath);

    try {
      await this.nativePdfPrint(filePath, {
        printer: printerName,
        copies: options.copies,
        orientation: options.orientation,
        scale: "noscale",
        silent: true,
        sumatraPdfPath: this.helperPath,
      });
      return {};
    } catch (error) {
      throw new PrintFailure(
        nativeFailureMessage(error),
        "spooler_error",
        true,
      );
    }
  }

  async printTestPage(printerName: string): Promise<PrintResult> {
    await this.requireAvailablePrinter(printerName);
    return this.printHtmlFile(this.testPagePath, printerName, {
      copies: 1,
      paper_width_mm: 62,
      paper_height_mm: 100,
      orientation: "portrait",
      margin_mm: 5,
    });
  }

  private async requireAvailablePrinter(printerName: string): Promise<void> {
    const printer = (await this.listPrinters()).find(
      (item) => item.name === printerName,
    );
    if (!printer) {
      throw new PrintFailure(
        "The requested printer is not installed.",
        "printer_not_found",
        true,
      );
    }
    if (printer.status === "offline") {
      throw new PrintFailure(
        "The selected printer is offline.",
        "printer_offline",
        true,
      );
    }
  }

  private async printHtmlFile(
    filePath: string,
    printerName: string,
    options: PrintOptions,
  ): Promise<PrintResult> {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    try {
      await window.loadURL(pathToFileURL(filePath).toString());
      await new Promise<void>((resolve, reject) => {
        window.webContents.print(
          createHtmlPrintOptions(printerName, options),
          (success, failureReason) => {
            if (success) resolve();
            else
              reject(
                new PrintFailure(
                  failureReason || "The print spooler rejected the job.",
                  "spooler_error",
                  true,
                ),
              );
          },
        );
      });
      return {};
    } finally {
      window.destroy();
    }
  }
}
