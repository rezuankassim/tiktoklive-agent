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
import type {
  PairInput,
  SettingsPatch,
  UpdateCheckResult,
} from "./shared/types";
import { AgentService } from "./main/agent-service";
import { LockbahApiClient } from "./main/api-client";
import { DeviceStore } from "./main/device-store";
import { JobProcessor } from "./main/job-processor";
import { JobStore } from "./main/job-store";
import { StructuredLogger } from "./main/logger";
import {
  ElectronPrintAdapter,
  resolveNativeHelperPath,
} from "./main/print-adapter";
import { SettingsStore } from "./main/settings-store";
import { TokenVault } from "./main/token-vault";

if (started) app.quit();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: AgentService;
let isQuitting = false;
let updatesConfigured = false;
let updateStatus: UpdateCheckResult | null = null;

function setUpdateStatus(result: UpdateCheckResult): UpdateCheckResult {
  updateStatus = result;
  mainWindow?.webContents.send("updates:status", result);
  return result;
}

function installDownloadedUpdate(): void {
  if (updateStatus?.status !== "downloaded") {
    throw new Error("No downloaded update is ready to install.");
  }
  setUpdateStatus({
    status: "installing",
    message: "Restarting to install the update...",
  });
  isQuitting = true;
  autoUpdater.quitAndInstall();
}

function iconPath(fileName: string): string {
  const baseDirectory = app.isPackaged
    ? process.resourcesPath
    : app.getAppPath();
  return path.join(baseDirectory, "assets", fileName);
}

function configureUpdates(): void {
  if (
    !app.isPackaged ||
    !LOCKBAH_UPDATE_URL ||
    !["win32", "darwin"].includes(process.platform)
  )
    return;
  const platform = `${process.platform}-${process.arch}`;
  const feedUrl = `${LOCKBAH_UPDATE_URL.replace(/\/$/, "")}/${platform}/${app.getVersion()}`;
  autoUpdater.setFeedURL({ url: feedUrl });
  if (updatesConfigured) return;
  updatesConfigured = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateStatus({ status: "checking", message: "Checking for updates..." });
  });
  autoUpdater.on("update-available", () => {
    setUpdateStatus({
      status: "available",
      message: "An update is available and is downloading now.",
    });
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateStatus({
      status: "not-available",
      message: `Version ${app.getVersion()} is up to date.`,
    });
  });
  autoUpdater.on("error", (error) => {
    setUpdateStatus({ status: "error", message: error.message });
  });
  autoUpdater.on("update-downloaded", () => {
    setUpdateStatus({
      status: "downloaded",
      message: "The update is downloaded and ready to install.",
    });
    void dialog
      .showMessageBox({
        type: "info",
        title: "Update ready",
        message: "A new version of Lockbah Print Agent is ready to install.",
        detail: "Restart the app now to finish the update.",
        buttons: ["Restart and install", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          installDownloadedUpdate();
        }
      });
  });
}

function loadWindowContent(window: BrowserWindow): void {
  if (!app.isPackaged && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

function createWindow(loadContent = true): BrowserWindow {
  const window = new BrowserWindow({
    icon: iconPath("icon.png"),
    width: 480,
    height: 760,
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
  if (loadContent) loadWindowContent(window);
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
  if (process.platform === "darwin") {
    app.dock?.setIcon(iconPath("icon.png"));
  }
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
  mainWindow = createWindow(false);
  configureUpdates();
  const testPagePath = app.isPackaged
    ? path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/test-page.html`,
      )
    : path.join(app.getAppPath(), "public", "test-page.html");
  const printer = new ElectronPrintAdapter(testPagePath, {
    platform: process.platform,
    helperPath: resolveNativeHelperPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
  });
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
      return setUpdateStatus({
        status: "unavailable",
        message: "Update checks are only available in an installed build.",
      });
    if (!["win32", "darwin"].includes(process.platform))
      return setUpdateStatus({
        status: "unavailable",
        message: "Automatic updates are available on Windows and macOS.",
      });
    if (!LOCKBAH_UPDATE_URL)
      return setUpdateStatus({
        status: "unavailable",
        message:
          "This build cannot check for updates. Install the latest build.",
      });
    if (
      updateStatus?.status === "checking" ||
      updateStatus?.status === "available" ||
      updateStatus?.status === "downloaded" ||
      updateStatus?.status === "installing"
    ) {
      return updateStatus;
    }
    const checking = setUpdateStatus({
      status: "checking",
      message: "Checking for updates...",
    });
    autoUpdater.checkForUpdates();
    return checking;
  });
  ipcMain.handle("updates:status:get", () => updateStatus);
  ipcMain.handle("updates:install", () => installDownloadedUpdate());

  const icon = nativeImage.createFromPath(iconPath("tray.png"));
  if (icon.isEmpty()) throw new Error("The tray icon could not be loaded.");
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
  loadWindowContent(mainWindow);
  const openedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin;
  if (!openedAtLogin || !service.getStatus().paired) showWindow();
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
