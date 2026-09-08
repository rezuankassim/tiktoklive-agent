import os from "node:os";
import type { App } from "electron";
import type {
  AgentStatus,
  PairInput,
  Preferences,
  PrinterInfo,
  SettingsPatch,
} from "../shared/types";
import { ApiError, LockbahApiClient } from "./api-client";
import { ExponentialBackoff } from "./backoff";
import { DeviceStore } from "./device-store";
import { JobProcessor } from "./job-processor";
import type { StructuredLogger } from "./logger";
import type { PrintAdapter } from "./print-contract";
import { SettingsStore } from "./settings-store";
import { TokenVault } from "./token-vault";

export class AgentService {
  private status!: AgentStatus;
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = true;
  private readonly backoff = new ExponentialBackoff();

  constructor(
    private readonly app: App,
    private readonly settings: SettingsStore,
    private readonly devices: DeviceStore,
    private readonly tokens: TokenVault,
    private readonly api: LockbahApiClient,
    private readonly processor: JobProcessor,
    private readonly printer: PrintAdapter,
    private readonly logger: StructuredLogger,
    private readonly emit: (status: AgentStatus) => void,
  ) {}

  async start(): Promise<void> {
    const [preferences, token, device] = await Promise.all([
      this.settings.get(),
      this.tokens.load(),
      this.devices.load(),
    ]);
    this.api.setBaseUrl(preferences.apiBaseUrl);
    this.app.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin });
    this.status = {
      appVersion: this.app.getVersion(),
      paired: Boolean(token && device),
      deviceName: device?.name || null,
      connection: "disconnected",
      printer: await this.selectedPrinter(preferences),
      currentJob: null,
      lastError: null,
      preferences,
    };
    this.emitStatus();
    if (this.status.paired) {
      this.stopped = false;
      await this.processor.recover();
      await this.heartbeat().catch((error: unknown) => this.recordError(error));
      this.scheduleHeartbeat();
      this.schedulePoll(0);
    }
  }

  getStatus(): AgentStatus {
    return structuredClone(this.status);
  }

  async pair(input: PairInput): Promise<void> {
    const pairingCode = input.pairingCode.trim().toUpperCase();
    const name = input.deviceName.trim();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairingCode)) {
      throw new Error("Enter the pairing code in ABCD-EFGH format.");
    }
    if (name.length < 2 || name.length > 80) {
      throw new Error("Device name must be between 2 and 80 characters.");
    }
    const result = await this.api.pair({
      pairingCode,
      name,
      platform: process.platform,
      appVersion: this.app.getVersion(),
    });
    await this.tokens.save(result.token);
    await this.devices.save(result.device);
    this.status.paired = true;
    this.status.deviceName = result.device.name;
    this.status.lastError = null;
    this.stopped = false;
    this.emitStatus();
    await this.logger.log("info", "device_paired", {
      deviceId: result.device.id,
    });
    await this.heartbeat();
    this.scheduleHeartbeat();
    this.schedulePoll(0);
  }

  async unpair(): Promise<void> {
    this.stopTimers();
    await this.tokens.clear();
    this.status.paired = false;
    this.status.deviceName = null;
    this.status.connection = "disconnected";
    this.emitStatus();
    await this.logger.log("info", "device_unpaired");
  }

  async handleUnauthorized(): Promise<void> {
    await this.unpair();
    this.status.lastError = "This device was revoked. Pair it again.";
    this.emitStatus();
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    return this.printer.listPrinters();
  }

  async updateSettings(patch: SettingsPatch): Promise<void> {
    const preferences = await this.settings.update(patch);
    this.api.setBaseUrl(preferences.apiBaseUrl);
    this.app.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin });
    this.status.preferences = preferences;
    this.status.printer = await this.selectedPrinter(preferences);
    this.emitStatus();
    if (this.status.paired && Object.hasOwn(patch, "printerName"))
      await this.heartbeat();
    if (Object.hasOwn(patch, "pollingIntervalMs")) this.schedulePoll(0);
  }

  async sendHeartbeat(): Promise<void> {
    await this.heartbeat();
  }

  async printTestPage(): Promise<void> {
    const name = this.status.preferences.printerName;
    if (!name) throw new Error("Select a printer first.");
    if (!this.printer.printTestPage)
      throw new Error("Test printing is unavailable.");
    await this.printer.printTestPage(name);
  }

  setCurrentJob(job: AgentStatus["currentJob"]): void {
    this.status.currentJob = job;
    this.emitStatus();
  }

  setError(message: string): void {
    this.status.lastError = message;
    this.emitStatus();
  }

  private async heartbeat(): Promise<void> {
    this.status.connection = "connecting";
    this.emitStatus();
    await this.api.heartbeat({
      platform: process.platform,
      appVersion: this.app.getVersion(),
      printerName: this.status.preferences.printerName,
      printerStatus: this.status.printer?.status || "unknown",
      hostname: os.hostname().slice(0, 64),
    });
    this.status.connection = "connected";
    this.emitStatus();
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.status.paired) return;
    try {
      const job = await this.api.claim();
      this.backoff.reset();
      this.status.connection = "connected";
      this.emitStatus();
      if (job) await this.processor.accept(job);
      this.schedulePoll(this.status.preferences.pollingIntervalMs);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      const delay = this.backoff.next();
      this.status.connection = "backoff";
      this.recordError(error);
      this.schedulePoll(delay);
    }
  }

  private schedulePoll(delay: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (!this.stopped)
      this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!this.stopped) {
      this.heartbeatTimer = setInterval(
        () =>
          void this.heartbeat().catch((error: unknown) =>
            this.recordError(error),
          ),
        30_000,
      );
    }
  }

  private stopTimers(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private async selectedPrinter(
    preferences: Preferences,
  ): Promise<PrinterInfo | null> {
    if (!preferences.printerName) return null;
    return (
      (await this.printer.listPrinters()).find(
        (printer) => printer.name === preferences.printerName,
      ) || {
        name: preferences.printerName,
        displayName: preferences.printerName,
        status: "offline",
        isDefault: false,
      }
    );
  }

  private recordError(error: unknown): void {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    this.status.lastError = message;
    this.emitStatus();
    void this.logger.log("error", "agent_error", { message });
  }

  private emitStatus(): void {
    this.emit(structuredClone(this.status));
  }
}
