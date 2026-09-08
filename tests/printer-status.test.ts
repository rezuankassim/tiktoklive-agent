import { describe, expect, it } from "vitest";
import { printerStatus } from "../src/main/printer-status";

describe("printerStatus", () => {
  it("reads the top-level Windows status returned by Chromium", () => {
    expect(printerStatus({ status: 0, options: {} }, "win32")).toBe("online");
    expect(printerStatus({ status: 0x80, options: {} }, "win32")).toBe(
      "offline",
    );
    expect(printerStatus({ status: 0x8, options: {} }, "win32")).toBe("error");
  });

  it("maps CUPS printer states", () => {
    expect(printerStatus({ options: { "printer-state": "3" } }, "darwin")).toBe(
      "online",
    );
    expect(printerStatus({ options: { "printer-state": "5" } }, "linux")).toBe(
      "offline",
    );
  });

  it("treats a listed printer without status data as available", () => {
    expect(printerStatus({ options: {} }, "win32")).toBe("online");
  });
});
