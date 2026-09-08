export class ExponentialBackoff {
  private failures = 0;

  constructor(
    private readonly initialMs = 2_000,
    private readonly maximumMs = 30_000,
  ) {}

  next(): number {
    const delay = Math.min(this.initialMs * 2 ** this.failures, this.maximumMs);
    this.failures += 1;
    return delay;
  }

  reset(): void {
    this.failures = 0;
  }
}
