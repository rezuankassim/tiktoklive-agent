export type PrinterStatus = "unknown" | "online" | "offline" | "error";

export type JobPhase =
  | "claimed"
  | "content_verified"
  | "submitted_to_spooler"
  | "server_acknowledged";

export interface PrintOptions {
  copies: number;
  paper_width_mm: number;
  paper_height_mm: number;
  orientation: "portrait" | "landscape";
  margin_mm: number;
  dpi?: number;
}

export interface PrintJob {
  id: string;
  title: string;
  content_type: "application/pdf";
  content_url: string;
  content_checksum: string;
  content_size: number;
  printer_name: string;
  options: PrintOptions;
  attempt: number;
  lease_token: string;
  lease_expires_at: string;
}

export interface ActiveJob {
  phase: JobPhase;
  job: PrintJob;
  pdfPath?: string;
  spoolJobId?: string;
}

export interface Preferences {
  apiBaseUrl: string;
  printerName: string | null;
  launchAtLogin: boolean;
  pollingIntervalMs: number;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  status: PrinterStatus;
  isDefault: boolean;
}

export interface AgentStatus {
  paired: boolean;
  deviceName: string | null;
  connection: "disconnected" | "connecting" | "connected" | "backoff";
  printer: PrinterInfo | null;
  currentJob: { id: string; phase: JobPhase } | null;
  lastError: string | null;
  preferences: Preferences;
}

export interface PairInput {
  pairingCode: string;
  deviceName: string;
}

export interface SettingsPatch {
  printerName?: string | null;
  launchAtLogin?: boolean;
  pollingIntervalMs?: number;
  apiBaseUrl?: string;
}

export interface UpdateCheckResult {
  status: "started" | "unavailable";
  message: string;
}

export interface RendererApi {
  getStatus(): Promise<AgentStatus>;
  pair(input: PairInput): Promise<void>;
  unpair(): Promise<void>;
  listPrinters(): Promise<PrinterInfo[]>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  printTestPage(): Promise<void>;
  exportLogs(): Promise<string | null>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  onStatus(callback: (status: AgentStatus) => void): () => void;
}
