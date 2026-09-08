import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StructuredLogger, redact } from "../src/main/logger";
import { TokenVault } from "../src/main/token-vault";

describe("secure persistence and logging", () => {
  it("persists only encrypted token bytes", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lockbah-token-test-"),
    );
    const filePath = path.join(directory, "token.bin");
    const vault = new TokenVault(filePath, {
      isEncryptionAvailable: () => true,
      encryptString: (value) =>
        Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa)),
      decryptString: (value) =>
        Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xaa)).toString(),
    });
    await vault.save("lbp_plaintext-token");
    expect((await readFile(filePath)).toString()).not.toContain(
      "lbp_plaintext-token",
    );
    await expect(vault.load()).resolves.toBe("lbp_plaintext-token");
  });

  it("fails closed when secure storage is unavailable", async () => {
    const vault = new TokenVault("/unused", {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    });
    await expect(vault.save("secret")).rejects.toThrow(
      "Secure token storage is unavailable.",
    );
  });

  it("redacts credentials, codes, PDF data, customer data, and response bodies", async () => {
    const value = redact({
      authorization: "Bearer secret",
      token: "lbp_token",
      lease_token: "lease",
      pairing_code: "ABCD-EFGH",
      pdf: "bytes",
      customerName: "Ada",
      responseBody: { message: "private" },
      message: "failed Bearer abc lbp_hidden",
      safe: "job-1",
    });
    expect(JSON.stringify(value)).toBe(
      JSON.stringify({
        authorization: "[REDACTED]",
        token: "[REDACTED]",
        lease_token: "[REDACTED]",
        pairing_code: "[REDACTED]",
        pdf: "[REDACTED]",
        customerName: "[REDACTED]",
        responseBody: "[REDACTED]",
        message: "failed Bearer [REDACTED] [REDACTED]",
        safe: "job-1",
      }),
    );

    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lockbah-log-test-"),
    );
    const filePath = path.join(directory, "agent.jsonl");
    await new StructuredLogger(filePath).log("error", "request_failed", {
      token: "lbp_secret",
      customer: "Alice",
    });
    const written = await readFile(filePath, "utf8");
    expect(written).not.toContain("lbp_secret");
    expect(written).not.toContain("Alice");
  });
});
