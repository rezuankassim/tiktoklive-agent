import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJson } from "../src/main/json-file";
import {
  PRODUCTION_API_BASE_URL,
  SettingsStore,
} from "../src/main/settings-store";

describe("SettingsStore production API boundary", () => {
  it("forces packaged builds to Lockbah even when a development URL was stored", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lockbah-settings-test-"),
    );
    const filePath = path.join(directory, "settings.json");
    await writeJson(filePath, {
      apiBaseUrl: "http://localhost:8000",
      printerName: null,
      launchAtLogin: false,
      pollingIntervalMs: 2_000,
    });

    const store = new SettingsStore(filePath, true);
    await expect(store.get()).resolves.toMatchObject({
      apiBaseUrl: PRODUCTION_API_BASE_URL,
    });
    await expect(
      store.update({ apiBaseUrl: "https://staging.example.com" }),
    ).resolves.toMatchObject({ apiBaseUrl: PRODUCTION_API_BASE_URL });
  });
});
