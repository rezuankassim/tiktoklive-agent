import { readJson, writeJson } from "./json-file";

export interface DeviceRecord {
  id: string;
  name: string;
}

export class DeviceStore {
  constructor(private readonly filePath: string) {}

  load(): Promise<DeviceRecord | null> {
    return readJson<DeviceRecord>(this.filePath);
  }

  save(device: DeviceRecord): Promise<void> {
    return writeJson(this.filePath, device);
  }
}
