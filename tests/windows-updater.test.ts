import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ net: { fetch: fetchMock } }));

import {
  compareVersions,
  downloadWindowsUpdate,
  windowsMsiUrl,
} from "../src/main/windows-updater";

const directories: string[] = [];
afterEach(async () => {
  fetchMock.mockReset();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function release(
  version: string,
  bytes: Uint8Array,
  digest?: string,
): Response {
  return Response.json({
    tag_name: version,
    assets: [
      {
        name: "LockbahPrintAgent.msi",
        size: bytes.length,
        digest: `sha256:${digest ?? createHash("sha256").update(bytes).digest("hex")}`,
      },
    ],
  });
}

describe("Windows MSI updates", () => {
  it("compares three-part release versions", () => {
    expect(compareVersions("v1.0.9", "1.0.8")).toBe(1);
    expect(compareVersions("1.0.8", "v1.0.8")).toBe(0);
    expect(compareVersions("1.0.7", "1.0.8")).toBe(-1);
  });

  it("downloads only a newer release and verifies its digest", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lockbah-update-test-"),
    );
    directories.push(directory);
    const bytes = new TextEncoder().encode("sample installer bytes");
    fetchMock.mockResolvedValueOnce(release("1.0.9", bytes));
    fetchMock.mockResolvedValueOnce(new Response(bytes));

    const update = await downloadWindowsUpdate("1.0.8", directory, vi.fn());
    expect(update?.version).toBe("1.0.9");
    if (!update) throw new Error("Expected an update.");
    expect(await readFile(update.filePath)).toEqual(Buffer.from(bytes));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(windowsMsiUrl);
  });

  it("does not download the installed version again", async () => {
    const bytes = new TextEncoder().encode("sample installer bytes");
    fetchMock.mockResolvedValueOnce(release("1.0.9", bytes));

    const update = await downloadWindowsUpdate("1.0.9", os.tmpdir(), vi.fn());
    expect(update).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes an installer whose digest does not match", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lockbah-update-test-"),
    );
    directories.push(directory);
    const bytes = new TextEncoder().encode("sample installer bytes");
    fetchMock.mockResolvedValueOnce(release("1.0.9", bytes, "0".repeat(64)));
    fetchMock.mockResolvedValueOnce(new Response(bytes));

    await expect(
      downloadWindowsUpdate("1.0.8", directory, vi.fn()),
    ).rejects.toThrow("integrity check");
    expect(await readdir(directory)).toEqual([]);
  });
});
