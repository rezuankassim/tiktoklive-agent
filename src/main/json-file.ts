import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}
