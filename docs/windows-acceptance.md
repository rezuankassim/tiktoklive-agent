# Windows print acceptance

Run this checklist on the signed release candidate. Record the Windows version, printer driver version, connection type, and result for each printer.

## Standard office printer

- Install the vendor driver and confirm Windows can print its test page.
- Pair the agent, select the exact system printer, and print the Lockbah test page.
- Claim a one-page PDF job. Confirm the app opens no dialog and sends one copy to the selected queue.
- Repeat with two copies, landscape orientation, non-default margins, and explicit DPI.
- Disconnect or pause the printer. Confirm the agent reports `printer_offline` as retryable and does not use another printer.
- Restart the app after spooler submission but before the submitted response. Confirm it acknowledges the existing job without printing again.

## Pilot thermal printer

- Record the pilot model and driver version here: ________________________________.
- Configure a 62 × 100 mm stock size in the vendor driver.
- Print the test page and a server PDF whose media box is 62 × 100 mm.
- Measure the printed content box and confirm the 5 mm margins within the printer's physical tolerance.
- Repeat portrait and landscape jobs, one and two copies, and every DPI used by the pilot.
- Confirm Chromium honors the PDF media box and custom page size without scaling or clipping.
- If it does not, stop release approval. Replace `ElectronPrintAdapter` with the planned signed native helper or PDFium adapter. Do not change the API client or job processor.

## Update and installation

- Install the signed Squirrel setup on a clean Windows user account.
- Confirm the publisher name and signature in the file properties and the Windows prompt.
- Enable start after sign-in, sign out, and confirm the tray agent starts once.
- Publish a higher version to the update feed. Confirm the agent downloads it and Squirrel installs it after restart.
- Revoke the device in Lockbah. Confirm the next authenticated request stops polling and shows the pairing screen.
