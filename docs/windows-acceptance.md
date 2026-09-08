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

1. Record the Windows version: ________________________________.
2. Record the printer manufacturer and exact model: ________________________________.
3. In **Settings > Bluetooth & devices > Printers & scanners > [target printer] > Printer properties**, record the driver name and version: ________________________________.
4. Record the connection type, such as USB, Ethernet, or Wi-Fi: ________________________________.
5. In the vendor driver, create or select exactly 62 × 100 mm stock. Disable driver scaling options such as **Fit to page**.
6. Print the Windows test page and confirm the target printer is online.
7. Start the signed agent, select the target printer by its exact system name, save the setting, and click **Print test page**. Confirm no print dialog opens and one page prints with black text on white paper.
8. Measure the test page content. Confirm it has 5 mm margins, within the printer's stated physical tolerance, and is not clipped or rotated.
9. Submit a server PDF with a 62 × 100 mm MediaBox and 5 mm margins in its layout. Confirm no print dialog opens, the background remains white, and the printed content matches the Laravel preview without another margin.
10. Create or select 100 × 100 mm stock in the printer driver. Submit a real 100 × 100 mm production PDF with margins in its MediaBox. Confirm the output contains black text and does not print a solid black or blank page.
11. Submit portrait and landscape server PDFs. Confirm each uses the PDF's page dimensions and is not scaled, clipped, or rotated unexpectedly.
12. Submit jobs for one copy and two copies. Confirm the printer produces exactly the requested count.
13. Submit one job for each DPI value used by the deployment. Record the DPI and result: ________________________________.
14. Change the saved printer name to a name that is not installed, then submit a job. Confirm the agent reports `printer_not_found`, sends nothing to the default printer or any other queue, and opens no dialog. Restore the target printer afterward.
15. Pause the target printer queue, submit a job, and confirm the agent reports retryable `printer_offline`. Confirm no other printer receives the job. Resume and clear the queue afterward.
16. Submit one job, then close the agent after Windows accepts it into the spooler but before the server records the submitted response. Restart the agent. Confirm it acknowledges the stored job and the physical copy count does not increase.
17. Submit the 100 × 100 mm production PDF at 203 DPI and 300 DPI where the pilot printer and driver support those resolutions. Record the DPI and result: ________________________________.
18. Record a pass or fail for visible text, paper size, orientation, copy count, placement, white background, scaling, clipping, rotation, printer selection, silent printing, and duplicate prevention.

If the PDF prints black or blank, or the driver scales or clips it, stop release approval. Record the printer model, driver, job settings, and sample PDF. Do not change the API client or server job contract.

## Update and installation

- Install the signed Squirrel setup on a clean Windows user account.
- Confirm the publisher name and signature in the file properties and the Windows prompt.
- Enable start after sign-in, sign out, and confirm the tray agent starts once.
- Publish a higher version to the update feed. Confirm the agent downloads it and Squirrel installs it after restart.
- Revoke the device in Lockbah. Confirm the next authenticated request stops polling and shows the pairing screen.
