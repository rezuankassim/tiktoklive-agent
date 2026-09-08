import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileTextIcon,
  LaptopIcon,
  LogOutIcon,
  PrinterIcon,
  RefreshCwIcon,
  WifiIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { AgentStatus, PrinterInfo } from "@/shared/types";
import "./index.css";

type Notice = { message: string; error: boolean } | null;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The action failed.";
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function statusVariant(value: string): "default" | "secondary" | "destructive" {
  if (["connected", "online", "server_acknowledged"].includes(value)) {
    return "default";
  }
  if (["offline", "error", "disconnected", "backoff"].includes(value)) {
    return "destructive";
  }
  return "secondary";
}

function StatusItem({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  value: string;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription className="truncate">{value}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant={statusVariant(value)}>{value.split(" · ")[0]}</Badge>
      </ItemActions>
    </Item>
  );
}

function PairingCard({ onPaired }: { onPaired: () => Promise<void> }) {
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await window.lockbah.pair({ pairingCode, deviceName });
      await onPaired();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pair this computer</CardTitle>
        <CardDescription>
          Enter the single-use code shown in Lockbah. Pairing codes expire after
          a short time.
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent>
          <FieldGroup className="gap-6">
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="pairing-code">Pairing code</FieldLabel>
              <Input
                id="pairing-code"
                value={pairingCode}
                onChange={(event) =>
                  setPairingCode(event.target.value.toUpperCase())
                }
                placeholder="ABCD-EFGH"
                maxLength={9}
                autoComplete="off"
                aria-invalid={Boolean(error)}
                required
              />
              <FieldDescription>
                Use the code from your Lockbah device settings.
              </FieldDescription>
            </Field>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="device-name">Device name</FieldLabel>
              <Input
                id="device-name"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="Packing laptop"
                maxLength={80}
                aria-invalid={Boolean(error)}
                required
              />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="pt-8">
          <Button className="w-full" type="submit" disabled={submitting}>
            {submitting ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <LaptopIcon data-icon="inline-start" />
            )}
            {submitting ? "Pairing" : "Pair device"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function Dashboard({
  status,
  refresh,
}: {
  status: AgentStatus;
  refresh: () => Promise<void>;
}) {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [working, setWorking] = useState<string | null>(null);

  const loadPrinters = useCallback(async () => {
    setWorking("refresh");
    try {
      setPrinters(await window.lockbah.listPrinters());
      setNotice(null);
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
    } finally {
      setWorking(null);
    }
  }, []);

  useEffect(() => {
    void loadPrinters();
  }, [loadPrinters]);

  const printerItems = useMemo(
    () => [
      { label: "Select a printer", value: null as string | null },
      ...printers.map((printer) => ({
        label:
          printer.displayName === printer.name
            ? `${printer.name} · ${printer.status}`
            : `${printer.displayName} (${printer.name}) · ${printer.status}`,
        value: printer.name as string | null,
      })),
    ],
    [printers],
  );
  const selectedPrinter =
    printerItems.find(
      (item) => item.value === status.preferences.printerName,
    ) ?? printerItems[0];

  async function act(
    name: string,
    action: () => Promise<unknown>,
    success: string,
  ) {
    setWorking(name);
    setNotice(null);
    try {
      await action();
      setNotice({ message: success, error: false });
      await refresh();
    } catch (error) {
      setNotice({ message: errorMessage(error), error: true });
    } finally {
      setWorking(null);
    }
  }

  const jobValue = status.currentJob
    ? `${status.currentJob.phase} · ${status.currentJob.id}`
    : "Idle";
  const printerValue = status.printer
    ? `${status.printer.status} · ${status.printer.displayName}`
    : "Not selected";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{status.deviceName || "Paired device"}</CardTitle>
        <CardDescription>
          Print jobs are claimed and sent one at a time.
        </CardDescription>
        <CardAction>
          <Badge variant={statusVariant(status.connection)}>
            {status.connection}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <ItemGroup className="gap-1">
          <StatusItem
            icon={WifiIcon}
            label="Connection"
            value={status.connection}
          />
          <StatusItem icon={PrinterIcon} label="Printer" value={printerValue} />
          <StatusItem
            icon={FileTextIcon}
            label="Current job"
            value={jobValue}
          />
          <StatusItem
            icon={AlertCircleIcon}
            label="Last error"
            value={status.lastError || "None"}
          />
        </ItemGroup>

        {status.lastError ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Agent needs attention</AlertTitle>
            <AlertDescription>{status.lastError}</AlertDescription>
          </Alert>
        ) : null}

        <FieldGroup className="gap-6">
          <Field>
            <FieldLabel htmlFor="printer">System printer</FieldLabel>
            <div className="flex gap-2">
              <Select
                items={printerItems}
                value={selectedPrinter}
                onValueChange={(item) =>
                  void act(
                    "printer",
                    () =>
                      window.lockbah.updateSettings({
                        printerName: item?.value ?? null,
                      }),
                    "Printer saved.",
                  )
                }
                itemToStringValue={(item) => item.label}
              >
                <SelectTrigger id="printer" className="w-full">
                  <SelectValue>{(item) => item?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {printerItems.map((item) => (
                      <SelectItem key={item.value || "none"} value={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Refresh printers"
                disabled={working === "refresh"}
                onClick={() => void loadPrinters()}
              >
                {working === "refresh" ? <Spinner /> : <RefreshCwIcon />}
              </Button>
            </div>
            <FieldDescription>
              Lockbah uses the system printer name shown in parentheses.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle id="launch-at-login-label">
                Start after sign-in
              </FieldTitle>
              <FieldDescription>
                Keep the print agent available in the system tray.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="launch-at-login"
              aria-labelledby="launch-at-login-label"
              checked={status.preferences.launchAtLogin}
              onCheckedChange={(checked) =>
                void act(
                  "startup",
                  () =>
                    window.lockbah.updateSettings({ launchAtLogin: checked }),
                  "Startup setting saved.",
                )
              }
            />
          </Field>
        </FieldGroup>

        {notice ? (
          <Alert variant={notice.error ? "destructive" : "default"}>
            {notice.error ? <AlertCircleIcon /> : <CheckCircle2Icon />}
            <AlertTitle>{notice.error ? "Action failed" : "Done"}</AlertTitle>
            <AlertDescription>{notice.message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="grid grid-cols-2 gap-2 pt-2">
        <Button
          type="button"
          disabled={working === "print" || !status.preferences.printerName}
          onClick={() =>
            void act(
              "print",
              () => window.lockbah.printTestPage(),
              "The operating system accepted the test page.",
            )
          }
        >
          {working === "print" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PrinterIcon data-icon="inline-start" />
          )}
          Test print
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void act(
              "logs",
              () => window.lockbah.exportLogs(),
              "Logs exported.",
            )
          }
        >
          <DownloadIcon data-icon="inline-start" />
          Export logs
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void act(
              "updates",
              () => window.lockbah.checkForUpdates(),
              "Update check started.",
            )
          }
        >
          <RefreshCwIcon data-icon="inline-start" />
          Check updates
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() =>
            void act(
              "unpair",
              () => window.lockbah.unpair(),
              "Device unpaired.",
            )
          }
        >
          <LogOutIcon data-icon="inline-start" />
          Unpair
        </Button>
      </CardFooter>
    </Card>
  );
}

function App() {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await window.lockbah.getStatus());
  }, []);

  useEffect(() => {
    const unsubscribe = window.lockbah.onStatus(setStatus);
    void refresh();
    return unsubscribe;
  }, [refresh]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-6 p-6">
      <header className="flex items-center gap-3 px-1 pt-1">
        <img
          src="/logo.png"
          alt=""
          className="size-12 object-contain"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h1 className="font-heading text-xl font-semibold tracking-wide uppercase">
            Lockbah
          </h1>
          <p className="text-sm text-muted-foreground">Print Agent</p>
        </div>
      </header>
      {!status ? (
        <Card size="sm">
          <CardContent className="flex items-center gap-3">
            <Spinner />
            <p className="text-sm text-muted-foreground">
              Loading agent status
            </p>
          </CardContent>
        </Card>
      ) : status.paired ? (
        <Dashboard status={status} refresh={refresh} />
      ) : (
        <PairingCard onPaired={refresh} />
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing renderer root.");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
