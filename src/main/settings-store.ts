import { readJson, writeJson } from "./json-file";
import type { Preferences, SettingsPatch } from "../shared/types";

export const PRODUCTION_API_BASE_URL = "https://lockbah.com";

export function defaultPreferences(isPackaged: boolean): Preferences {
  const developmentUrl = process.env.LOCKBAH_API_BASE_URL;
  return {
    apiBaseUrl: isPackaged
      ? PRODUCTION_API_BASE_URL
      : developmentUrl || PRODUCTION_API_BASE_URL,
    printerName: null,
    launchAtLogin: false,
    pollingIntervalMs: 2_000,
  };
}

export class SettingsStore {
  constructor(
    private readonly filePath: string,
    private readonly isPackaged: boolean,
  ) {}

  async get(): Promise<Preferences> {
    const stored = await readJson<Partial<Preferences>>(this.filePath);
    return this.validate({ ...defaultPreferences(this.isPackaged), ...stored });
  }

  async update(patch: SettingsPatch): Promise<Preferences> {
    const next = this.validate({ ...(await this.get()), ...patch });
    await writeJson(this.filePath, next);
    return next;
  }

  private validate(value: Preferences): Preferences {
    const url = new URL(
      this.isPackaged ? PRODUCTION_API_BASE_URL : value.apiBaseUrl,
    );
    if (value.pollingIntervalMs < 1_000 || value.pollingIntervalMs > 30_000) {
      throw new Error("Polling interval must be between 1 and 30 seconds.");
    }
    return { ...value, apiBaseUrl: url.origin };
  }
}
