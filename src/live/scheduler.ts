/**
 * Runs a task repeatedly with a delay that is re-read before every wait,
 * so interval changes made through the API apply without a restart.
 */
export class PollingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private busy = false;
  private rerunRequested = false;

  constructor(
    private readonly task: () => Promise<unknown>,
    private readonly nextDelayMs: () => Promise<number>,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs the task as soon as possible (right after the current run, if one is in progress). */
  trigger(): void {
    if (this.stopped) return;
    if (this.busy) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    void this.tick();
  }

  private async tick(): Promise<void> {
    this.busy = true;
    do {
      this.rerunRequested = false;
      // The task reports its own failures; a rejected run must never kill the loop.
      await this.task().catch(() => undefined);
    } while (this.rerunRequested && !this.stopped);
    this.busy = false;

    if (this.stopped) return;
    const delay = await this.nextDelayMs().catch(() => 30 * 60_000);
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }
}
