import type { PrintOptions, PrinterInfo } from "../shared/types";

export interface PrintResult {
  spoolJobId?: string;
}

export interface PrintAdapter {
  listPrinters(): Promise<PrinterInfo[]>;
  printPdf(
    filePath: string,
    printerName: string,
    options: PrintOptions,
  ): Promise<PrintResult>;
  printTestPage?(printerName: string): Promise<PrintResult>;
}

export class PrintFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
