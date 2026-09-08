import type { PrintJob, PrinterStatus } from "../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface PairResponse {
  device: { id: string; name: string };
  token: string;
}

export interface HeartbeatInput {
  platform: NodeJS.Platform;
  appVersion: string;
  printerName: string | null;
  printerStatus: PrinterStatus;
  hostname: string;
}

export function heartbeatPayload(
  input: HeartbeatInput,
): Record<string, unknown> {
  return {
    platform: input.platform,
    app_version: input.appVersion,
    printer_name: input.printerName,
    printer_status: input.printerStatus,
    metadata: { hostname: input.hostname },
  };
}

export interface FailedJobInput {
  leaseToken: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0)
    throw new ApiError(
      "The claim response was invalid.",
      502,
      "invalid_response",
    );
  return value;
}

function boundedNumber(
  source: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = source[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ApiError(
      "The claim response was invalid.",
      502,
      "invalid_response",
    );
  }
  return value;
}

export function parsePrintJob(value: unknown): PrintJob {
  if (!value || typeof value !== "object")
    throw new ApiError(
      "The claim response was invalid.",
      502,
      "invalid_response",
    );
  const source = value as Record<string, unknown>;
  const rawOptions = source.options;
  if (!rawOptions || typeof rawOptions !== "object")
    throw new ApiError(
      "The claim response was invalid.",
      502,
      "invalid_response",
    );
  const options = rawOptions as Record<string, unknown>;
  const id = requiredString(source, "id");
  const checksum = requiredString(source, "content_checksum");
  const leaseToken = requiredString(source, "lease_token");
  const leaseExpiry = requiredString(source, "lease_expires_at");
  const orientation = requiredString(options, "orientation");
  const contentUrl = requiredString(source, "content_url");
  let contentProtocol = "";
  try {
    contentProtocol = new URL(contentUrl).protocol;
  } catch {
    // The shared validation error below avoids exposing the supplied URL.
  }
  if (
    !/^[A-Za-z0-9-]{1,128}$/.test(id) ||
    !/^[a-fA-F0-9]{64}$/.test(checksum) ||
    leaseToken.length !== 64 ||
    Number.isNaN(Date.parse(leaseExpiry)) ||
    !["portrait", "landscape"].includes(orientation) ||
    !["http:", "https:"].includes(contentProtocol) ||
    source.content_type !== "application/pdf"
  ) {
    throw new ApiError(
      "The claim response was invalid.",
      502,
      "invalid_response",
    );
  }
  const dpi = options.dpi;
  if (
    dpi !== undefined &&
    (typeof dpi !== "number" || dpi < 72 || dpi > 2_400)
  ) {
    throw new ApiError(
      "The claim response was invalid.",
      502,
      "invalid_response",
    );
  }
  return {
    id,
    title: requiredString(source, "title"),
    content_type: "application/pdf",
    content_url: contentUrl,
    content_checksum: checksum,
    content_size: boundedNumber(source, "content_size", 1, 100 * 1024 * 1024),
    printer_name: requiredString(source, "printer_name"),
    options: {
      copies: boundedNumber(options, "copies", 1, 100),
      paper_width_mm: boundedNumber(options, "paper_width_mm", 1, 500),
      paper_height_mm: boundedNumber(options, "paper_height_mm", 1, 500),
      orientation: orientation as "portrait" | "landscape",
      margin_mm: boundedNumber(options, "margin_mm", 0, 100),
      ...(typeof dpi === "number" ? { dpi } : {}),
    },
    attempt: boundedNumber(source, "attempt", 1, 1_000),
    lease_token: leaseToken,
    lease_expires_at: leaseExpiry,
  };
}

export class LockbahApiClient {
  constructor(
    private baseUrl: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly onUnauthorized: () => Promise<void>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly requireHttps = true,
  ) {
    if (requireHttps && new URL(baseUrl).protocol !== "https:") {
      throw new Error("Production API requests require HTTPS.");
    }
  }

  setBaseUrl(baseUrl: string): void {
    if (this.requireHttps && new URL(baseUrl).protocol !== "https:") {
      throw new Error("Production API requests require HTTPS.");
    }
    this.baseUrl = baseUrl;
  }

  async pair(input: {
    pairingCode: string;
    name: string;
    platform: NodeJS.Platform;
    appVersion: string;
  }): Promise<PairResponse> {
    const response = await this.request(
      "/api/print-agent/pair",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          pairing_code: input.pairingCode,
          name: input.name,
          platform: input.platform,
          app_version: input.appVersion,
        }),
      },
      false,
    );
    if (response.status === 422) {
      const body = (await response.json()) as { message?: unknown };
      throw new ApiError(
        typeof body.message === "string"
          ? body.message
          : "The pairing code is invalid.",
        422,
        "validation_failed",
      );
    }
    if (response.status !== 201) await this.throwResponseError(response);
    const body = (await response.json()) as PairResponse;
    if (!body.token || !body.device?.id || !body.device.name) {
      throw new ApiError(
        "The pairing response was incomplete.",
        502,
        "invalid_response",
      );
    }
    return body;
  }

  async heartbeat(input: HeartbeatInput): Promise<void> {
    const response = await this.authenticated("/api/print-agent/heartbeat", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(heartbeatPayload(input)),
    });
    if (!response.ok) await this.throwResponseError(response);
  }

  async claim(): Promise<PrintJob | null> {
    const response = await this.authenticated("/api/print-agent/jobs/claim", {
      method: "POST",
    });
    if (response.status === 204) return null;
    if (response.status !== 200) await this.throwResponseError(response);
    const body = (await response.json()) as { job?: unknown };
    return parsePrintJob(body.job);
  }

  async download(job: PrintJob, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertAllowedUrl(job.content_url);
    const response = await this.authenticated(job.content_url, {
      headers: { "X-Print-Lease-Token": job.lease_token },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) await this.throwResponseError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async renewLease(jobId: string, leaseToken: string): Promise<string | null> {
    const response = await this.authenticated(
      `/api/print-agent/jobs/${encodeURIComponent(jobId)}/lease`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lease_token: leaseToken }),
      },
    );
    if (response.status === 409) return null;
    if (!response.ok) await this.throwResponseError(response);
    const body = (await response.json().catch(() => ({}))) as {
      lease_expires_at?: string;
    };
    return body.lease_expires_at || new Date(Date.now() + 30_000).toISOString();
  }

  async submitted(
    jobId: string,
    leaseToken: string,
    spoolJobId?: string,
  ): Promise<void> {
    const response = await this.authenticated(
      `/api/print-agent/jobs/${encodeURIComponent(jobId)}/submitted`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lease_token: leaseToken,
          ...(spoolJobId ? { spool_job_id: spoolJobId } : {}),
        }),
      },
    );
    if (!response.ok) await this.throwResponseError(response);
  }

  async failed(jobId: string, input: FailedJobInput): Promise<void> {
    const response = await this.authenticated(
      `/api/print-agent/jobs/${encodeURIComponent(jobId)}/failed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lease_token: input.leaseToken,
          error_code: input.errorCode,
          error_message: input.errorMessage,
          retryable: input.retryable,
        }),
      },
    );
    if (!response.ok) await this.throwResponseError(response);
  }

  private async authenticated(
    pathOrUrl: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = await this.getToken();
    if (!token)
      throw new ApiError("The device is not paired.", 401, "unauthorized");
    const response = await this.request(pathOrUrl, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...init.headers,
      },
    });
    if (response.status === 401) {
      await this.onUnauthorized();
      throw new ApiError(
        "This device must be paired again.",
        401,
        "unauthorized",
      );
    }
    return response;
  }

  private request(
    pathOrUrl: string,
    init: RequestInit,
    enforce = true,
  ): Promise<Response> {
    const url = new URL(pathOrUrl, `${this.baseUrl}/`);
    if (enforce) this.assertAllowedUrl(url.toString());
    return this.fetcher(url, init);
  }

  private assertAllowedUrl(value: string): void {
    const url = new URL(value);
    if (this.requireHttps && url.protocol !== "https:") {
      throw new ApiError(
        "An insecure API URL was rejected.",
        0,
        "insecure_url",
      );
    }
  }

  private async throwResponseError(response: Response): Promise<never> {
    throw new ApiError(
      `Lockbah returned HTTP ${response.status}.`,
      response.status,
      "http_error",
    );
  }
}
