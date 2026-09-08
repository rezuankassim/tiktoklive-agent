import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LockbahApiClient } from "../src/main/api-client";
import { JobProcessor } from "../src/main/job-processor";
import { JobStore } from "../src/main/job-store";
import { PrintFailure, type PrintAdapter } from "../src/main/print-contract";
import type { ActiveJob, PrintJob } from "../src/shared/types";

const pdf = new TextEncoder().encode("%PDF-1.7 test");
const checksum = createHash("sha256").update(pdf).digest("hex");

function job(): PrintJob {
  return {
    id: "job-1",
    title: "Private customer title",
    content_type: "application/pdf",
    content_url: "https://lockbah.com/content",
    content_checksum: checksum,
    content_size: pdf.byteLength,
    printer_name: "Brother_QL_820NWB",
    options: {
      copies: 1,
      paper_width_mm: 62,
      paper_height_mm: 100,
      orientation: "portrait",
      margin_mm: 5,
    },
    attempt: 1,
    lease_token: "lease-secret",
    lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
  };
}

function api() {
  return {
    download: vi.fn(async () => pdf),
    renewLease: vi.fn<() => Promise<string | null>>(async () =>
      new Date(Date.now() + 30_000).toISOString(),
    ),
    submitted: vi.fn(async () => undefined),
    failed: vi.fn(async () => undefined),
  };
}

async function harness(initial?: ActiveJob) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lockbah-job-test-"));
  const store = new JobStore(path.join(directory, "active.json"));
  if (initial) await store.save(initial);
  const mockApi = api();
  const printer: PrintAdapter = {
    listPrinters: vi.fn(async () => []),
    printPdf: vi.fn(async () => ({})),
  };
  const errors: string[] = [];
  const processor = new JobProcessor(
    mockApi as unknown as LockbahApiClient,
    store,
    printer,
    path.join(directory, "pdfs"),
    {
      changed: vi.fn(),
      error: (message) => errors.push(message),
    },
  );
  return { directory, store, mockApi, printer, processor, errors };
}

describe("JobProcessor", () => {
  beforeEach(() => vi.useRealTimers());

  it("rejects length and checksum mismatches after one verified redownload", async () => {
    const h = await harness();
    h.mockApi.download.mockResolvedValue(new TextEncoder().encode("wrong"));
    await h.processor.accept(job());
    expect(h.mockApi.download).toHaveBeenCalledTimes(2);
    expect(h.printer.printPdf).not.toHaveBeenCalled();
    expect(h.mockApi.failed).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        errorCode: "invalid_content",
        retryable: false,
      }),
    );
  });

  it("reports an exact printer-name mismatch as retryable", async () => {
    const h = await harness();
    vi.mocked(h.printer.printPdf).mockRejectedValue(
      new PrintFailure(
        "The requested printer is not installed.",
        "printer_not_found",
        true,
      ),
    );
    await h.processor.accept(job());
    expect(h.mockApi.failed).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        errorCode: "printer_not_found",
        retryable: true,
      }),
    );
  });

  it("does not continue recovery after lease renewal returns HTTP 409", async () => {
    const h = await harness({ phase: "claimed", job: job() });
    h.mockApi.renewLease.mockResolvedValue(null);
    await h.processor.recover();
    expect(h.mockApi.download).not.toHaveBeenCalled();
    expect(h.printer.printPdf).not.toHaveBeenCalled();
    expect(h.errors[0]).toContain("another device");
  });

  it("renews the lease while waiting for a slow spooler callback", async () => {
    vi.useFakeTimers();
    const h = await harness();
    vi.mocked(h.printer.printPdf).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 20_000)),
    );
    const processing = h.processor.accept(job());
    await vi.waitFor(() => expect(h.printer.printPdf).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.mockApi.renewLease).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await processing;
  });

  it("records spooler submission before stopping after a lease conflict", async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.mockApi.renewLease.mockResolvedValue(null);
    vi.mocked(h.printer.printPdf).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 20_000)),
    );
    const processing = h.processor.accept(job());
    await vi.waitFor(() => expect(h.printer.printPdf).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(21_000);
    await processing;
    expect((await h.store.load())?.phase).toBe("submitted_to_spooler");
    expect(h.mockApi.submitted).not.toHaveBeenCalled();
    await h.processor.recover();
    expect(h.printer.printPdf).toHaveBeenCalledOnce();
  });

  it("retries a lost submitted response without printing twice", async () => {
    const h = await harness();
    h.mockApi.submitted
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(undefined);
    await h.processor.accept(job());
    expect(h.printer.printPdf).toHaveBeenCalledOnce();
    expect((await h.store.load())?.phase).toBe("submitted_to_spooler");
    await h.processor.recover();
    expect(h.printer.printPdf).toHaveBeenCalledOnce();
    expect(h.mockApi.submitted).toHaveBeenCalledTimes(2);
    expect((await h.store.load())?.phase).toBe("server_acknowledged");
  });

  it.each([
    "claimed",
    "content_verified",
    "submitted_to_spooler",
    "server_acknowledged",
  ] as const)("recovers safely from the %s phase", async (phase) => {
    const current = job();
    const h = await harness();
    const pdfPath = path.join(h.directory, "saved.pdf");
    if (phase === "content_verified") await writeFile(pdfPath, pdf);
    await h.store.save({
      phase,
      job: current,
      ...(phase === "content_verified" ? { pdfPath } : {}),
      ...(phase === "submitted_to_spooler" ? { spoolJobId: "spool-7" } : {}),
    });
    await h.processor.recover();
    if (phase === "submitted_to_spooler" || phase === "server_acknowledged")
      expect(h.printer.printPdf).not.toHaveBeenCalled();
    else expect(h.printer.printPdf).toHaveBeenCalledOnce();
    if (phase === "server_acknowledged")
      expect(h.mockApi.submitted).not.toHaveBeenCalled();
    else expect(h.mockApi.submitted).toHaveBeenCalledOnce();
  });
});
