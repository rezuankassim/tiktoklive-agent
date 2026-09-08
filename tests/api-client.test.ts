import { describe, expect, it, vi } from "vitest";
import { LockbahApiClient, heartbeatPayload } from "../src/main/api-client";
import { ExponentialBackoff } from "../src/main/backoff";

describe("LockbahApiClient", () => {
  it("treats a 204 claim response as no work and sends authentication", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new LockbahApiClient(
      "https://lockbah.com",
      async () => "lbp_secret",
      async () => undefined,
      fetcher,
    );
    await expect(client.claim()).resolves.toBeNull();
    const [, request] = fetcher.mock.calls[0] ?? [];
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      "Bearer lbp_secret",
    );
    expect(new Headers(request?.headers).get("Accept")).toBe(
      "application/json",
    );
  });

  it("returns the validation message for HTTP 422 pairing without exposing the code", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ message: "This pairing code has expired." }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const client = new LockbahApiClient(
      "https://lockbah.com",
      async () => null,
      async () => undefined,
      fetcher,
    );
    await expect(
      client.pair({
        pairingCode: "ABCD-EFGH",
        name: "Packing laptop",
        platform: "win32",
        appVersion: "0.1.0",
      }),
    ).rejects.toThrow("This pairing code has expired.");
    expect(String(fetcher.mock.calls)).not.toContain("lbp_");
  });

  it("builds the required heartbeat payload", () => {
    expect(
      heartbeatPayload({
        platform: "win32",
        appVersion: "0.1.0",
        printerName: "Brother_QL_820NWB",
        printerStatus: "online",
        hostname: "packing-desk",
      }),
    ).toEqual({
      platform: "win32",
      app_version: "0.1.0",
      printer_name: "Brother_QL_820NWB",
      printer_status: "online",
      metadata: { hostname: "packing-desk" },
    });
  });

  it("clears authentication after an HTTP 401", async () => {
    const revoked = vi.fn(async () => undefined);
    const client = new LockbahApiClient(
      "https://lockbah.com",
      async () => "token",
      revoked,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
    );
    await expect(client.claim()).rejects.toMatchObject({ status: 401 });
    expect(revoked).toHaveBeenCalledOnce();
  });

  it("rejects insecure production URLs", () => {
    expect(
      () =>
        new LockbahApiClient(
          "http://lockbah.com",
          async () => null,
          async () => undefined,
        ),
    ).toThrow("HTTPS");
  });
});

describe("ExponentialBackoff", () => {
  it("backs off exponentially, caps at 30 seconds, and resets", () => {
    const backoff = new ExponentialBackoff();
    expect([
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
    ]).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    backoff.reset();
    expect(backoff.next()).toBe(2_000);
  });
});
