import "./index.css";
import type { AgentStatus, PrinterInfo } from "./shared/types";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};

const pairing = byId<HTMLElement>("pairing");
const dashboard = byId<HTMLElement>("dashboard");
const pairForm = byId<HTMLFormElement>("pair-form");
const pairError = byId<HTMLElement>("pair-error");
const actionMessage = byId<HTMLElement>("action-message");
const printerSelect = byId<HTMLSelectElement>("printer");
const launchAtLogin = byId<HTMLInputElement>("launch-at-login");

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

function setMessage(message: string, isError = false): void {
  actionMessage.textContent = message;
  actionMessage.classList.toggle("error", isError);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The action failed.";
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

async function refreshPrinters(selected: string | null): Promise<void> {
  const printers = await window.lockbah.listPrinters();
  printerSelect.replaceChildren(new Option("Select a printer", ""));
  printers.forEach((printer: PrinterInfo) => {
    const label =
      printer.displayName === printer.name
        ? printer.name
        : `${printer.displayName} (${printer.name})`;
    printerSelect.add(new Option(`${label} · ${printer.status}`, printer.name));
  });
  printerSelect.value = selected || "";
}

function render(status: AgentStatus): void {
  pairing.hidden = status.paired;
  dashboard.hidden = !status.paired;
  if (!status.paired) return;
  setText("device-name", status.deviceName || "Paired device");
  setText("connection-status", status.connection);
  setText(
    "printer-status",
    status.printer
      ? `${status.printer.displayName} · ${status.printer.status}`
      : "No printer selected",
  );
  setText(
    "job-status",
    status.currentJob
      ? `${status.currentJob.id} · ${status.currentJob.phase}`
      : "Idle",
  );
  setText("last-error", status.lastError || "None");
  launchAtLogin.checked = status.preferences.launchAtLogin;
  if (printerSelect.value !== (status.preferences.printerName || "")) {
    void refreshPrinters(status.preferences.printerName).catch(
      (error: unknown) => setMessage(errorMessage(error), true),
    );
  }
}

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  pairError.textContent = "";
  const button = byId<HTMLButtonElement>("pair-button");
  button.disabled = true;
  try {
    await window.lockbah.pair({
      pairingCode: byId<HTMLInputElement>("pairing-code").value,
      deviceName: byId<HTMLInputElement>("device-name-input").value,
    });
  } catch (error) {
    pairError.textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
});

printerSelect.addEventListener("change", async () => {
  try {
    await window.lockbah.updateSettings({
      printerName: printerSelect.value || null,
    });
    setMessage("Printer saved.");
  } catch (error) {
    setMessage(errorMessage(error), true);
  }
});
launchAtLogin.addEventListener("change", async () => {
  try {
    await window.lockbah.updateSettings({
      launchAtLogin: launchAtLogin.checked,
    });
    setMessage("Startup setting saved.");
  } catch (error) {
    setMessage(errorMessage(error), true);
  }
});
byId("refresh-printers").addEventListener("click", () => {
  void refreshPrinters(printerSelect.value || null).catch((error: unknown) =>
    setMessage(errorMessage(error), true),
  );
});
byId("test-print").addEventListener("click", () => {
  void window.lockbah.printTestPage().then(
    () => setMessage("The operating system accepted the test page."),
    (error: unknown) => setMessage(errorMessage(error), true),
  );
});
byId("export-logs").addEventListener("click", () => {
  void window.lockbah.exportLogs().then(
    (destination) =>
      destination && setMessage(`Logs exported to ${destination}`),
    (error: unknown) => setMessage(errorMessage(error), true),
  );
});
byId("check-updates").addEventListener("click", () => {
  void window.lockbah.checkForUpdates().then(
    () => setMessage("Update check started."),
    (error: unknown) => setMessage(errorMessage(error), true),
  );
});
byId("unpair").addEventListener("click", () => {
  void window.lockbah
    .unpair()
    .catch((error: unknown) => setMessage(errorMessage(error), true));
});

window.lockbah.onStatus(render);
void window.lockbah.getStatus().then((status) => {
  render(status);
  return refreshPrinters(status.preferences.printerName);
});
