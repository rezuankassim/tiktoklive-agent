import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { net } from "electron";

const releaseApiUrl =
  "https://api.github.com/repos/rezuankassim/tiktoklive-agent/releases/latest";
export const windowsMsiUrl =
  "https://github.com/rezuankassim/tiktoklive-agent/releases/latest/download/LockbahPrintAgent.msi";
const installerName = "LockbahPrintAgent.msi";
const maximumInstallerSize = 500 * 1024 * 1024;

interface ReleaseAsset {
  name: string;
  size: number;
  digest: string | null;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error(`Invalid release version: ${value}`);
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export async function downloadWindowsUpdate(
  currentVersion: string,
  temporaryDirectory: string,
  onDownload: (version: string) => void,
): Promise<{ filePath: string; version: string } | null> {
  const metadataResponse = await net.fetch(releaseApiUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!metadataResponse.ok) {
    throw new Error(
      `Could not check GitHub releases (${metadataResponse.status}).`,
    );
  }
  const release = (await metadataResponse.json()) as Release;
  if (compareVersions(release.tag_name, currentVersion) <= 0) return null;
  const asset = release.assets?.find((item) => item.name === installerName);
  if (!asset)
    throw new Error(`Release ${release.tag_name} has no ${installerName}.`);
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? "")?.[1];
  if (
    !digest ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > maximumInstallerSize
  ) {
    throw new Error(
      "The release installer has no valid size or SHA-256 digest.",
    );
  }

  onDownload(release.tag_name);
  const response = await net.fetch(windowsMsiUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the installer (${response.status}).`);
  }

  const directory = await mkdtemp(
    path.join(temporaryDirectory, "lockbah-msi-"),
  );
  const filePath = path.join(directory, installerName);
  let verified = false;
  try {
    const file = await open(filePath, "wx");
    let downloaded = 0;
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    try {
      let chunk = await reader.read();
      while (!chunk.done) {
        const value = chunk.value;
        downloaded += value.byteLength;
        if (downloaded > asset.size || downloaded > maximumInstallerSize) {
          throw new Error(
            "The installer download is larger than the release asset.",
          );
        }
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await file.write(
            value,
            offset,
            value.byteLength - offset,
          );
          offset += bytesWritten;
        }
        chunk = await reader.read();
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      await file.close();
    }
    if (
      downloaded !== asset.size ||
      hash.digest("hex") !== digest.toLowerCase()
    ) {
      throw new Error("The downloaded installer failed its integrity check.");
    }
    verified = true;
    return { filePath, version: release.tag_name };
  } finally {
    if (!verified) await rm(directory, { recursive: true, force: true });
  }
}
