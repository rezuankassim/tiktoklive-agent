import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  Tray,
} from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";
import type { PairInput, SettingsPatch } from "./shared/types";
import { AgentService } from "./main/agent-service";
import { LockbahApiClient } from "./main/api-client";
import { DeviceStore } from "./main/device-store";
import { JobProcessor } from "./main/job-processor";
import { JobStore } from "./main/job-store";
import { StructuredLogger } from "./main/logger";
import { ElectronPrintAdapter } from "./main/print-adapter";
import { SettingsStore } from "./main/settings-store";
import { TokenVault } from "./main/token-vault";

if (started) app.quit();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: AgentService;
let isQuitting = false;

function configureUpdates(): void {
  if (
    !app.isPackaged ||
    !LOCKBAH_UPDATE_URL ||
    !["win32", "darwin"].includes(process.platform)
  )
    return;
  const feedUrl = `${LOCKBAH_UPDATE_URL.replace(/\/$/, "")}/${process.platform}/${process.arch}/${app.getVersion()}`;
  autoUpdater.setFeedURL({ url: feedUrl });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 670,
    minWidth: 400,
    minHeight: 580,
    show: false,
    title: "Lockbah Print Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const localDevelopmentPage =
      !app.isPackaged &&
      Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL) &&
      url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!url.startsWith("file:") && !localDevelopmentPage)
      event.preventDefault();
  });
  if (!app.isPackaged && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

function showWindow(): void {
  if (!mainWindow) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function validatePair(value: unknown): PairInput {
  if (!value || typeof value !== "object")
    throw new Error("Invalid pairing details.");
  const input = value as Record<string, unknown>;
  if (
    typeof input.pairingCode !== "string" ||
    typeof input.deviceName !== "string"
  ) {
    throw new Error("Invalid pairing details.");
  }
  return { pairingCode: input.pairingCode, deviceName: input.deviceName };
}

function validateSettings(value: unknown): SettingsPatch {
  if (!value || typeof value !== "object") throw new Error("Invalid settings.");
  const source = value as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if ("printerName" in source) {
    if (source.printerName !== null && typeof source.printerName !== "string") {
      throw new Error("Invalid printer.");
    }
    patch.printerName = source.printerName as string | null;
  }
  if ("launchAtLogin" in source) {
    if (typeof source.launchAtLogin !== "boolean")
      throw new Error("Invalid startup setting.");
    patch.launchAtLogin = source.launchAtLogin;
  }
  if ("pollingIntervalMs" in source) {
    if (!Number.isInteger(source.pollingIntervalMs))
      throw new Error("Invalid polling interval.");
    patch.pollingIntervalMs = source.pollingIntervalMs as number;
  }
  if ("apiBaseUrl" in source) {
    if (typeof source.apiBaseUrl !== "string")
      throw new Error("Invalid API URL.");
    patch.apiBaseUrl = source.apiBaseUrl;
  }
  return patch;
}

async function bootstrap(): Promise<void> {
  const dataDirectory = app.getPath("userData");
  const privateTemporaryDirectory = path.join(
    app.getPath("temp"),
    "lockbah-print-agent",
  );
  const logger = new StructuredLogger(
    path.join(dataDirectory, "logs", "agent.jsonl"),
  );
  const settings = new SettingsStore(
    path.join(dataDirectory, "settings.json"),
    app.isPackaged,
  );
  const tokens = new TokenVault(
    path.join(dataDirectory, "device-token.bin"),
    safeStorage,
  );
  const devices = new DeviceStore(path.join(dataDirectory, "device.json"));
  mainWindow = createWindow();
  const testPagePath = app.isPackaged
    ? path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/test-page.html`,
      )
    : path.join(app.getAppPath(), "public", "test-page.html");
  const printer = new ElectronPrintAdapter(testPagePath);
  const initialSettings = await settings.get();
  const api = new LockbahApiClient(
    initialSettings.apiBaseUrl,
    () => tokens.load(),
    () => service.handleUnauthorized(),
    fetch,
    app.isPackaged,
  );
  const jobs = new JobProcessor(
    api,
    new JobStore(path.join(dataDirectory, "active-job.json")),
    printer,
    privateTemporaryDirectory,
    {
      changed: (active) =>
        service?.setCurrentJob(
          active ? { id: active.job.id, phase: active.phase } : null,
        ),
      error: (message) => service?.setError(message),
    },
  );
  service = new AgentService(
    app,
    settings,
    devices,
    tokens,
    api,
    jobs,
    printer,
    logger,
    (status) => {
      mainWindow?.webContents.send("status:changed", status);
      tray?.setToolTip(`Lockbah Print Agent: ${status.connection}`);
    },
  );

  ipcMain.handle("status:get", () => service.getStatus());
  ipcMain.handle("pair", (_event, input: unknown) =>
    service.pair(validatePair(input)),
  );
  ipcMain.handle("unpair", () => service.unpair());
  ipcMain.handle("printers:list", () => service.listPrinters());
  ipcMain.handle("settings:update", (_event, patch: unknown) =>
    service.updateSettings(validateSettings(patch)),
  );
  ipcMain.handle("print:test", () => service.printTestPage());
  ipcMain.handle("logs:export", async () => {
    const result = await dialog.showSaveDialog({
      title: "Export Lockbah Print Agent logs",
      defaultPath: `lockbah-print-agent-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await logger.exportTo(result.filePath);
    return result.filePath;
  });
  ipcMain.handle("updates:check", async () => {
    if (!app.isPackaged)
      throw new Error("Update checks require a packaged build.");
    if (!["win32", "darwin"].includes(process.platform))
      throw new Error("Automatic updates are available on Windows and macOS.");
    if (!LOCKBAH_UPDATE_URL)
      throw new Error("This build has no update feed configured.");
    await autoUpdater.checkForUpdates();
  });

  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAKUlEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIwCAAAEEAAB0q6fNwAAAABJRU5ErkJggg==",
  );
  tray = new Tray(icon);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Lockbah Print Agent", click: showWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showWindow);
  await service.start();
  if (!service.getStatus().paired) showWindow();
  configureUpdates();
  if (app.isPackaged && LOCKBAH_UPDATE_URL) void autoUpdater.checkForUpdates();
}

app
  .whenReady()
  .then(bootstrap)
  .catch(async (error: unknown) => {
    await dialog.showMessageBox({
      type: "error",
      title: "Lockbah Print Agent",
      message:
        error instanceof Error ? error.message : "The app could not start.",
    });
    app.quit();
  });
app.on("window-all-closed", () => undefined);
app.on("activate", showWindow);
app.on("second-instance", showWindow);
app.on("before-quit", () => {
  isQuitting = true;
});
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
