import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const getAllWindows = vi.fn();
  const BrowserWindow = Object.assign(vi.fn(), { getAllWindows });
  return { BrowserWindow, getAllWindows };
});

vi.mock("electron", () => ({ BrowserWindow: electron.BrowserWindow }));

import {
  ElectronPrintAdapter,
  SUMATRA_EXECUTABLE,
  createHtmlPrintOptions,
  millimetersToCssPixels,
  resolveNativeHelperPath,
  type NativePdfPrint,
} from "../src/main/print-adapter";
import type { PrintOptions } from "../src/shared/types";

const jobOptions: PrintOptions = {
  copies: 2,
  paper_width_mm: 100,
  paper_height_mm: 100,
  orientation: "landscape",
  margin_mm: 5,
  dpi: 203,
};

function setInstalledPrinter(name = "Brother_QL_820NWB", options = {}) {
  electron.getAllWindows.mockReturnValue([
    {
      webContents: {
        getPrintersAsync: vi.fn(async () => [
          {
            name,
            displayName: name,
            options,
          },
        ]),
      },
    },
  ]);
}

async function createPdf(contents = "%PDF-1.7\nvalid test fixture") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lockbah-pdf-test-"));
  const filePath = path.join(directory, "job.pdf");
  await writeFile(filePath, contents);
  return filePath;
}

function createAdapter(nativePdfPrint: NativePdfPrint) {
  return new ElectronPrintAdapter("/app/test-page.html", {
    platform: "win32",
    helperPath: "C:\\app\\resources\\SumatraPDF.exe",
    nativePdfPrint,
  });
}

describe("HTML test-page print option conversion", () => {
  it("keeps HTML page sizing separate from native PDF printing", () => {
    const margin = millimetersToCssPixels(jobOptions.margin_mm);
    const options = createHtmlPrintOptions("Brother_QL_820NWB", jobOptions);

    expect(margin).toBeCloseTo(18.8976378);
    expect(options).toMatchObject({
      deviceName: "Brother_QL_820NWB",
      copies: 2,
      landscape: true,
      margins: {
        marginType: "custom",
        top: margin,
        bottom: margin,
        left: margin,
        right: margin,
      },
      pageSize: { width: 100_000, height: 100_000 },
      dpi: { horizontal: 203, vertical: 203 },
    });
  });
});

describe("ElectronPrintAdapter native PDF printing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prints the exact PDF path and printer without creating a BrowserWindow", async () => {
    const printerName = 'Warehouse Printer & Co; $(bad) "quoted"';
    const filePath = await createPdf();
    const nativePdfPrint = vi.fn<NativePdfPrint>(async () => undefined);
    setInstalledPrinter(printerName);

    await expect(
      createAdapter(nativePdfPrint).printPdf(filePath, printerName, jobOptions),
    ).resolves.toEqual({});

    expect(nativePdfPrint).toHaveBeenCalledWith(filePath, {
      printer: printerName,
      copies: 2,
      orientation: "landscape",
      scale: "noscale",
      silent: true,
      sumatraPdfPath: "C:\\app\\resources\\SumatraPDF.exe",
    });
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it("fails for a missing requested printer before native submission", async () => {
    const nativePdfPrint = vi.fn<NativePdfPrint>(async () => undefined);
    electron.getAllWindows.mockReturnValue([
      { webContents: { getPrintersAsync: vi.fn(async () => []) } },
    ]);

    await expect(
      createAdapter(nativePdfPrint).printPdf(
        await createPdf(),
        "missing-printer",
        jobOptions,
      ),
    ).rejects.toMatchObject({ code: "printer_not_found", retryable: true });
    expect(nativePdfPrint).not.toHaveBeenCalled();
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it("fails for an offline printer before native submission", async () => {
    const nativePdfPrint = vi.fn<NativePdfPrint>(async () => undefined);
    setInstalledPrinter("Brother_QL_820NWB", { "printer-state": "stopped" });

    await expect(
      createAdapter(nativePdfPrint).printPdf(
        await createPdf(),
        "Brother_QL_820NWB",
        jobOptions,
      ),
    ).rejects.toMatchObject({ code: "printer_offline", retryable: true });
    expect(nativePdfPrint).not.toHaveBeenCalled();
  });

  it("rejects unsupported platforms with a stable failure code", async () => {
    const nativePdfPrint = vi.fn<NativePdfPrint>(async () => undefined);
    setInstalledPrinter();
    const adapter = new ElectronPrintAdapter("/app/test-page.html", {
      platform: "darwin",
      helperPath: "/app/SumatraPDF.exe",
      nativePdfPrint,
    });

    await expect(
      adapter.printPdf(await createPdf(), "Brother_QL_820NWB", jobOptions),
    ).rejects.toMatchObject({
      code: "unsupported_platform",
      retryable: false,
    });
    expect(nativePdfPrint).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing file", path.join(os.tmpdir(), "missing-lockbah-job.pdf")],
    ["an invalid file", null],
  ])("rejects %s before native submission", async (_label, suppliedPath) => {
    const nativePdfPrint = vi.fn<NativePdfPrint>(async () => undefined);
    setInstalledPrinter();
    const filePath = suppliedPath ?? (await createPdf("not a PDF"));

    await expect(
      createAdapter(nativePdfPrint).printPdf(
        filePath,
        "Brother_QL_820NWB",
        jobOptions,
      ),
    ).rejects.toMatchObject({ code: "invalid_pdf", retryable: false });
    expect(nativePdfPrint).not.toHaveBeenCalled();
  });

  it("maps a native non-zero exit to a retryable spooler failure", async () => {
    const failure = Object.assign(new Error("Process exited with code 1"), {
      code: 1,
    });
    const nativePdfPrint = vi.fn<NativePdfPrint>(async () => {
      throw failure;
    });
    setInstalledPrinter();

    await expect(
      createAdapter(nativePdfPrint).printPdf(
        await createPdf(),
        "Brother_QL_820NWB",
        jobOptions,
      ),
    ).rejects.toMatchObject({ code: "spooler_error", retryable: true });
  });

  it("does not report submission until the native helper succeeds", async () => {
    let finish: (() => void) | undefined;
    const nativePdfPrint = vi.fn<NativePdfPrint>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    setInstalledPrinter();
    let submitted = false;

    const result = createAdapter(nativePdfPrint)
      .printPdf(await createPdf(), "Brother_QL_820NWB", jobOptions)
      .then((value) => {
        submitted = true;
        return value;
      });
    await vi.waitFor(() => expect(nativePdfPrint).toHaveBeenCalledOnce());
    expect(submitted).toBe(false);

    finish?.();
    await expect(result).resolves.toEqual({});
    expect(submitted).toBe(true);
  });

  it("resolves development and packaged helper paths", () => {
    expect(
      resolveNativeHelperPath({
        isPackaged: false,
        resourcesPath: "C:\\unused",
        appPath: "C:\\source",
      }),
    ).toBe(
      path.join(
        "C:\\source",
        "node_modules",
        "pdf-to-printer",
        "dist",
        SUMATRA_EXECUTABLE,
      ),
    );
    expect(
      resolveNativeHelperPath({
        isPackaged: true,
        resourcesPath: "C:\\installed\\resources",
        appPath: "C:\\unused",
      }),
    ).toBe(path.join("C:\\installed\\resources", SUMATRA_EXECUTABLE));
  });
});

describe("ElectronPrintAdapter HTML test-page printing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps BrowserWindow printing for the HTML test page", async () => {
    setInstalledPrinter();
    const loadURL = vi.fn(async () => undefined);
    const print = vi.fn(
      (
        _options: unknown,
        callback: (success: boolean, failureReason: string) => void,
      ) => callback(true, ""),
    );
    const destroy = vi.fn();
    electron.BrowserWindow.mockImplementation(() => ({
      loadURL,
      webContents: { print },
      destroy,
    }));

    await expect(
      createAdapter(vi.fn()).printTestPage("Brother_QL_820NWB"),
    ).resolves.toEqual({});
    expect(electron.BrowserWindow).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenCalledOnce();
    expect(print).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
