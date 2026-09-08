import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class TokenVault {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike,
  ) {}

  async save(token: string): Promise<void> {
    if (!token || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure token storage is unavailable.");
    }
    const encrypted = this.safeStorage.encryptString(token);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, encrypted, { mode: 0o600 });
  }

  async load(): Promise<string | null> {
    try {
      const encrypted = await readFile(this.filePath);
      if (!this.safeStorage.isEncryptionAvailable()) return null;
      return this.safeStorage.decryptString(encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
