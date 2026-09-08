import type { ActiveJob } from "../shared/types";
import { readJson, writeJson } from "./json-file";

export class JobStore {
  constructor(private readonly filePath: string) {}

  load(): Promise<ActiveJob | null> {
    return readJson<ActiveJob>(this.filePath);
  }

  save(job: ActiveJob): Promise<void> {
    return writeJson(this.filePath, job);
  }
}
