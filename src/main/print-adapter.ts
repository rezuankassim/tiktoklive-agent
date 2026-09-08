import {
  BrowserWindow,
  type PrinterInfo as ElectronPrinterInfo,
  type WebContentsPrintOptions,
} from "electron";
import { pathToFileURL } from "node:url";
import type { PrintOptions, PrinterInfo } from "../shared/types";
import {
  PrintFailure,
  type PrintAdapter,
  type PrintResult,
} from "./print-contract";
import { printerStatus } from "./printer-status";

const CSS_PIXELS_PER_INCH = 96;
const MILLIMETERS_PER_INCH = 25.4;

export function millimetersToCssPixels(millimeters: number): number {
  return (millimeters * CSS_PIXELS_PER_INCH) / MILLIMETERS_PER_INCH;
}

export function createPrintOptions(
  printerName: string,
  options: PrintOptions,
  documentType: "pdf" | "html",
): WebContentsPrintOptions {
  const margins: WebContentsPrintOptions["margins"] =
    documentType === "pdf"
      ? { marginType: "none" }
      : {
          marginType: "custom",
          top: millimetersToCssPixels(options.margin_mm),
          bottom: millimetersToCssPixels(options.margin_mm),
          left: millimetersToCssPixels(options.margin_mm),
          right: millimetersToCssPixels(options.margin_mm),
        };

  return {
    silent: true,
    printBackground: false,
    deviceName: printerName,
    copies: options.copies,
    landscape: options.orientation === "landscape",
    ...(options.dpi
      ? { dpi: { horizontal: options.dpi, vertical: options.dpi } }
      : {}),
    margins,
    pageSize: {
      width: Math.round(options.paper_width_mm * 1_000),
      height: Math.round(options.paper_height_mm * 1_000),
    },
  };
}

export class ElectronPrintAdapter implements PrintAdapter {
  constructor(private readonly testPagePath: string) {}

  async listPrinters(): Promise<PrinterInfo[]> {
    const owner = BrowserWindow.getAllWindows()[0];
    if (!owner) return [];
    return (await owner.webContents.getPrintersAsync()).map((printer) => ({
      name: printer.name,
      displayName: printer.displayName,
      status: printerStatus({
        status: (printer as ElectronPrinterInfo & { status?: number }).status,
        options: printer.options as unknown as Record<string, unknown>,
      }),
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
    return this.printLocalFile(filePath, printerName, options, "pdf");
  }

  async printTestPage(printerName: string): Promise<PrintResult> {
    await this.requireAvailablePrinter(printerName);
    return this.printLocalFile(
      this.testPagePath,
      printerName,
      {
        copies: 1,
        paper_width_mm: 62,
        paper_height_mm: 100,
        orientation: "portrait",
        margin_mm: 5,
      },
      "html",
    );
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

  private async printLocalFile(
    filePath: string,
    printerName: string,
    options: PrintOptions,
    documentType: "pdf" | "html",
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
      // loadURL resolves after did-finish-load, once the document's load event fires.
      await window.loadURL(pathToFileURL(filePath).toString());
      await new Promise<void>((resolve, reject) => {
        window.webContents.print(
          createPrintOptions(printerName, options, documentType),
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
