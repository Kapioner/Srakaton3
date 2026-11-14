/**
 * Runs a task repeatedly with a delay that is re-read before every wait,
 * so interval changes made through the API apply without a restart.
 * Never runs two loops at once, however often it is started, stopped or triggered.
 */
export class PollingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** True while a loop is running the task or computing the next delay. */
  private busy = false;
  private rerunRequested = false;

  constructor(
    private readonly task: () => Promise<unknown>,
    private readonly nextDelayMs: () => Promise<number>,
  ) {}

  get isRunning(): boolean {
    return !this.stopped;
  }

  /** Starts polling with an immediate run. No-op when already started. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.runSoon();
  }

  /** Stops polling. A run already in progress finishes, but no new one starts. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Runs the task as soon as possible (right after the current run, if one is in progress). */
  trigger(): void {
    if (!this.stopped) this.runSoon();
  }

  private runSoon(): void {
    if (this.busy) {
      this.rerunRequested = true;
      return;
    }
    this.clearTimer();
    void this.loop();
  }

  private async loop(): Promise<void> {
    this.busy = true;
    try {
      while (!this.stopped) {
        this.rerunRequested = false;
        // The task reports its own failures; a rejected run must never kill the loop.
        await this.task().catch(() => undefined);
        if (this.stopped || this.rerunRequested) continue;

        const delay = await this.nextDelayMs().catch(() => 30_000);
        if (this.stopped || this.rerunRequested) continue;

        this.timer = setTimeout(() => {
          this.timer = null;
          void this.loop();
        }, delay);
        this.timer.unref();
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
