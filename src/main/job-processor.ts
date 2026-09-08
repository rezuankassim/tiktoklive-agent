import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveJob, PrintJob } from "../shared/types";
import type { LockbahApiClient } from "./api-client";
import { JobStore } from "./job-store";
import { PrintFailure, type PrintAdapter } from "./print-contract";

export class LeaseLostError extends Error {}

export class ContentError extends Error {
  readonly code = "invalid_content";
  readonly retryable = false;
}

export interface JobProcessorEvents {
  changed(job: ActiveJob | null): void;
  error(message: string): void;
}

export class JobProcessor {
  private processing = false;

  constructor(
    private readonly api: LockbahApiClient,
    private readonly store: JobStore,
    private readonly printer: PrintAdapter,
    private readonly temporaryDirectory: string,
    private readonly events: JobProcessorEvents,
  ) {}

  async accept(job: PrintJob): Promise<void> {
    if (this.processing) return;
    const active: ActiveJob = { phase: "claimed", job };
    await this.store.save(active);
    await this.run(active, false);
  }

  async recover(): Promise<void> {
    const active = await this.store.load();
    if (!active) return;
    if (active.phase === "server_acknowledged") {
      await this.cleanup(active);
      return;
    }
    await this.run(active, true);
  }

  private async run(active: ActiveJob, recovering: boolean): Promise<void> {
    this.processing = true;
    this.events.changed(active);
    try {
      if (active.phase === "submitted_to_spooler") {
        await this.acknowledgeSubmitted(active);
        return;
      }

      if (recovering) {
        const renewed = await this.api.renewLease(
          active.job.id,
          active.job.lease_token,
        );
        if (!renewed)
          throw new LeaseLostError("The job lease belongs to another device.");
        active.job.lease_expires_at = renewed;
        await this.store.save(active);
      }

      if (active.phase === "claimed") {
        active.pdfPath = (
          await this.withLeaseRenewal(active, () =>
            this.downloadVerified(active.job),
          )
        ).result;
        active.phase = "content_verified";
        await this.store.save(active);
        this.events.changed(active);
      } else if (
        !active.pdfPath ||
        !(await this.fileStillValid(active.pdfPath, active.job))
      ) {
        active.pdfPath = (
          await this.withLeaseRenewal(active, () =>
            this.downloadVerified(active.job),
          )
        ).result;
        await this.store.save(active);
      }

      const outcome = await this.withLeaseRenewal(
        active,
        () =>
          this.printer.printPdf(
            active.pdfPath as string,
            active.job.printer_name,
            active.job.options,
          ),
        true,
      );
      active.phase = "submitted_to_spooler";
      if (outcome.result.spoolJobId)
        active.spoolJobId = outcome.result.spoolJobId;
      await this.store.save(active);
      this.events.changed(active);
      if (outcome.leaseLost) {
        throw new LeaseLostError("The job lease expired while printing.");
      }
      await this.acknowledgeSubmitted(active);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.events.error(error.message);
        return;
      }
      const failure = this.describeFailure(error);
      this.events.error(failure.message);
      if (active.phase === "submitted_to_spooler") return;
      try {
        await this.api.failed(active.job.id, {
          leaseToken: active.job.lease_token,
          errorCode: failure.code,
          errorMessage: failure.message,
          retryable: failure.retryable,
        });
        active.phase = "server_acknowledged";
        await this.store.save(active);
        await this.cleanup(active);
      } catch {
        // Keep the durable job record so recovery can retry safely.
      }
    } finally {
      this.processing = false;
    }
  }

  private async acknowledgeSubmitted(active: ActiveJob): Promise<void> {
    await this.api.submitted(
      active.job.id,
      active.job.lease_token,
      active.spoolJobId,
    );
    active.phase = "server_acknowledged";
    await this.store.save(active);
    this.events.changed(active);
    await this.cleanup(active);
  }

  private async downloadVerified(job: PrintJob): Promise<string> {
    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bytes = await this.api.download(job);
      if (bytes.byteLength === job.content_size) {
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum.toLowerCase() === job.content_checksum.toLowerCase()) {
          const filePath = path.join(this.temporaryDirectory, `${job.id}.pdf`);
          await writeFile(filePath, bytes, { mode: 0o600 });
          return filePath;
        }
      }
    }
    throw new ContentError("The PDF failed its size or checksum check twice.");
  }

  private async fileStillValid(
    filePath: string,
    job: PrintJob,
  ): Promise<boolean> {
    try {
      const bytes = await readFile(filePath);
      return (
        bytes.byteLength === job.content_size &&
        createHash("sha256").update(bytes).digest("hex").toLowerCase() ===
          job.content_checksum.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  private async withLeaseRenewal<T>(
    active: ActiveJob,
    work: () => Promise<T>,
    allowCompletedAfterLeaseLoss = false,
  ): Promise<{ result: T; leaseLost: boolean }> {
    let stopped = false;
    let leaseLost = false;
    let timer: NodeJS.Timeout | undefined;
    const renew = async (): Promise<void> => {
      const remaining = Math.max(
        new Date(active.job.lease_expires_at).getTime() - Date.now(),
        2_000,
      );
      timer = setTimeout(
        async () => {
          if (stopped) return;
          try {
            const expiry = await this.api.renewLease(
              active.job.id,
              active.job.lease_token,
            );
            if (!expiry) leaseLost = true;
            else {
              active.job.lease_expires_at = expiry;
              await this.store.save(active);
              await renew();
            }
          } catch {
            await renew();
          }
        },
        Math.max(1_000, Math.floor(remaining / 2)),
      );
    };
    await renew();
    try {
      const result = await work();
      if (leaseLost && !allowCompletedAfterLeaseLoss) {
        throw new LeaseLostError("The job lease expired before printing.");
      }
      return { result, leaseLost };
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  }

  private describeFailure(error: unknown): {
    code: string;
    message: string;
    retryable: boolean;
  } {
    if (error instanceof PrintFailure || error instanceof ContentError)
      return error;
    return {
      code: "temporary_error",
      message: error instanceof Error ? error.message : "The print job failed.",
      retryable: true,
    };
  }

  private async cleanup(active: ActiveJob): Promise<void> {
    if (active.pdfPath) await unlink(active.pdfPath).catch(() => undefined);
    this.events.changed(null);
  }
}
