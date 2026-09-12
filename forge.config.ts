import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import path from "node:path";

const packagerIcon =
  process.platform === "win32"
    ? "icon.ico"
    : process.platform === "darwin"
      ? "icon.icns"
      : "icon.png";
const sumatraPdfExecutable = path.resolve(
  __dirname,
  "node_modules/pdf-to-printer/dist/SumatraPDF-3.4.6-32.exe",
);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: "LockbahPrintAgent",
    extraResource: [path.resolve(__dirname, "assets"), sumatraPdfExecutable],
    icon: path.resolve(__dirname, "assets", packagerIcon),
    win32metadata: {
      CompanyName: "Lockbah",
      FileDescription: "Lockbah Print Agent",
      ProductName: "Lockbah Print Agent",
      InternalName: "LockbahPrintAgent",
      OriginalFilename: "LockbahPrintAgent.exe",
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "LockbahPrintAgent",
      setupExe: "LockbahPrintAgentSetup.exe",
      setupIcon: path.resolve(__dirname, "assets", "icon.ico"),
      loadingGif: path.resolve(__dirname, "assets", "install-spinner.gif"),
      ...(process.env.WINDOWS_CERTIFICATE_FILE &&
      process.env.WINDOWS_CERTIFICATE_PASSWORD
        ? {
            certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
          }
        : {}),
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
