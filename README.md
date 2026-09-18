# Lockbah Print Agent

Lockbah Print Agent is a tray application that claims PDF jobs from Lockbah and submits them to a named operating-system printer without a print dialog. Version 0.1.0 processes one job at a time and polls the durable claim endpoint.

## Development

Use Node.js 22 or later.

```sh
npm ci
cp .env.example .env
npm start
```

Development builds may set `LOCKBAH_API_BASE_URL=http://localhost:8000`. Packaged builds always use `https://lockbah.com`, including when a development URL remains in the local settings file.

```sh
npm run check
npm run package
npm run make
```

`npm run package` creates an unsigned development package in `out/`. `npm run make` creates the platform installer. CI runs formatting, linting, strict type checks, Vitest, and packaging on Linux, plus a Windows packaging smoke test.

Windows PDF jobs use the SumatraPDF helper bundled by `pdf-to-printer`. The adapter passes the PDF path and exact printer name through a library API that uses an argument array, waits for the native process to succeed, and disables scaling so the PDF MediaBox controls content size and margins. The Windows printer driver controls supported output resolutions such as 203 or 300 DPI. The HTML test page continues to use Electron printing.

## Security and local data

The renderer has no Node.js integration. Context isolation and sandboxing stay enabled. Preload exposes a small set of validated actions and never exposes `ipcRenderer`. Production UI loads from the packaged application.

Electron `safeStorage` encrypts the device token before it reaches disk. Preferences, the paired device ID, and active job phases use JSON files under Electron's user-data directory. Temporary PDFs use a private directory under the operating-system temporary directory. The agent removes a PDF only after Lockbah accepts the final acknowledgement.

Logs use JSON Lines and redact authorization values, device and lease tokens, pairing codes, PDF data, customer fields, and response bodies. The settings window has an explicit export action.

## Signing and releases

The Windows installer is an MSI built with WiX Toolset v3.14.0. Build it on Windows with WiX installed. CI publishes the MSI to GitHub Releases. The Windows app's **Get latest MSI** button opens the latest release page; users install new MSI versions manually. Keep the WiX `upgradeCode` in `forge.config.ts` unchanged so later MSI releases replace earlier MSI releases. The installer can be signed by setting `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD` in CI. Do not commit either value.

Release commands are:

```sh
npm ci
npm run check
npm run make -- --arch=x64
```

Existing Squirrel installations do not upgrade into MSI installations. Before installing the first MSI, quit the tray agent, uninstall the old Lockbah Print Agent from Windows Installed apps, then install the MSI. Keep the app data under `%APPDATA%\Lockbah Print Agent` so the device pairing and settings remain available. After installation, confirm the printer and **Start after sign-in** setting, then run a test print. Installing both editions side by side can leave duplicate startup entries.

The Lockbah owner still needs to provide:

- A Windows Authenticode code-signing certificate, its encrypted CI file, and its password.
- A public GitHub release page for MSI downloads, or a replacement download location in the app.
- The release repository or artifact bucket retention policy.
- The pilot thermal printer model, Windows driver version, target DPI, stock definition, and a physical test device.
- Apple Developer ID Application and installer identities, notarization credentials, and an update-feed decision before macOS release work starts.

Complete [the Windows acceptance checklist](docs/windows-acceptance.md) before the first pilot release. Raw ESC/POS, ZPL, and WebSockets are outside version 0.1.0.
