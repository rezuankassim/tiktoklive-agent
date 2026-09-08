import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const getAllWindows = vi.fn();
  const BrowserWindow = Object.assign(vi.fn(), { getAllWindows });
  return { BrowserWindow, getAllWindows };
});

vi.mock("electron", () => ({ BrowserWindow: electron.BrowserWindow }));

import {
  ElectronPrintAdapter,
  createPrintOptions,
  millimetersToCssPixels,
} from "../src/main/print-adapter";
import type { PrintOptions } from "../src/shared/types";

const jobOptions: PrintOptions = {
  copies: 2,
  paper_width_mm: 62,
  paper_height_mm: 100.5,
  orientation: "landscape",
  margin_mm: 5,
  dpi: 203,
};

describe("Electron print option conversion", () => {
  it("keeps PDF layout margins in the PDF itself", () => {
    const options = createPrintOptions("Brother_QL_820NWB", jobOptions, "pdf");

    expect(options).toMatchObject({
      silent: true,
      printBackground: false,
      deviceName: "Brother_QL_820NWB",
      copies: 2,
      landscape: true,
      margins: { marginType: "none" },
      pageSize: { width: 62_000, height: 100_500 },
      dpi: { horizontal: 203, vertical: 203 },
    });
  });

  it("converts HTML test-page margins from millimeters to CSS pixels", () => {
    const margin = millimetersToCssPixels(jobOptions.margin_mm);
    const options = createPrintOptions("Brother_QL_820NWB", jobOptions, "html");

    expect(margin).toBeCloseTo(18.8976378);
    expect(options.margins).toEqual({
      marginType: "custom",
      top: margin,
      bottom: margin,
      left: margin,
      right: margin,
    });
    expect(options.printBackground).toBe(false);
  });
});

describe("ElectronPrintAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never submits a missing requested printer", async () => {
    electron.getAllWindows.mockReturnValue([
      { webContents: { getPrintersAsync: vi.fn(async () => []) } },
    ]);
    const adapter = new ElectronPrintAdapter("/app/test-page.html");

    await expect(
      adapter.printPdf("/tmp/job.pdf", "missing-printer", jobOptions),
    ).rejects.toMatchObject({ code: "printer_not_found", retryable: true });
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it("rejects an offline requested printer before submission", async () => {
    electron.getAllWindows.mockReturnValue([
      {
        webContents: {
          getPrintersAsync: vi.fn(async () => [
            {
              name: "Brother_QL_820NWB",
              displayName: "Brother QL-820NWB",
              options: { "printer-state": "stopped" },
            },
          ]),
        },
      },
    ]);
    const adapter = new ElectronPrintAdapter("/app/test-page.html");

    await expect(
      adapter.printPdf("/tmp/job.pdf", "Brother_QL_820NWB", jobOptions),
    ).rejects.toMatchObject({ code: "printer_offline", retryable: true });
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it("waits for the document load event before printing", async () => {
    let finishLoad: (() => void) | undefined;
    const loadURL = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve;
        }),
    );
    const print = vi.fn(
      (
        _options: unknown,
        callback: (success: boolean, failureReason: string) => void,
      ) => callback(true, ""),
    );
    const destroy = vi.fn();
    electron.getAllWindows.mockReturnValue([
      {
        webContents: {
          getPrintersAsync: vi.fn(async () => [
            {
              name: "Brother_QL_820NWB",
              displayName: "Brother QL-820NWB",
              options: {},
            },
          ]),
        },
      },
    ]);
    electron.BrowserWindow.mockImplementation(() => ({
      loadURL,
      webContents: { print },
      destroy,
    }));
    const adapter = new ElectronPrintAdapter("/app/test-page.html");

    const result = adapter.printPdf(
      "/tmp/job.pdf",
      "Brother_QL_820NWB",
      jobOptions,
    );
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledOnce());
    expect(print).not.toHaveBeenCalled();

    finishLoad?.();
    await expect(result).resolves.toEqual({});
    expect(print).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
