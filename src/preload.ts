import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentStatus,
  PairInput,
  RendererApi,
  SettingsPatch,
} from "./shared/types";

const api: RendererApi = {
  getStatus: () => ipcRenderer.invoke("status:get") as Promise<AgentStatus>,
  pair: (input: PairInput) =>
    ipcRenderer.invoke("pair", input) as Promise<void>,
  unpair: () => ipcRenderer.invoke("unpair") as Promise<void>,
  listPrinters: () => ipcRenderer.invoke("printers:list"),
  updateSettings: (patch: SettingsPatch) =>
    ipcRenderer.invoke("settings:update", patch),
  printTestPage: () => ipcRenderer.invoke("print:test") as Promise<void>,
  exportLogs: () => ipcRenderer.invoke("logs:export") as Promise<string | null>,
  checkForUpdates: () => ipcRenderer.invoke("updates:check") as Promise<void>,
  onStatus: (callback: (status: AgentStatus) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: AgentStatus,
    ): void => callback(status);
    ipcRenderer.on("status:changed", listener);
    return () => ipcRenderer.removeListener("status:changed", listener);
  },
};

contextBridge.exposeInMainWorld("lockbah", Object.freeze(api));
