import type { Mode } from './domain.js';
import type { PollingScheduler } from './scheduler.js';

export interface ModeState {
  mode: Mode;
  /** Whether data is currently being pulled from FIRMS. */
  acquiring: boolean;
  since: string;
  /** When a paused mode falls back to realtime on its own; `null` = never. */
  resumeAt: string | null;
}

export type ModeListener = (state: ModeState) => void;

/**
 * Decides whether FIRMS acquisition runs, based on what the user is doing:
 *  - `realtime`: polling on,
 *  - `archive` / `forecast`: polling off, so the live data stays frozen while it is being looked at.
 *
 * A paused mode reverts to realtime after `resumeAfterMinutes`, so a closed browser tab can never
 * leave acquisition stopped for good. The frontend renews the pause by sending the mode again.
 */
export class AcquisitionController {
  private state: ModeState;
  private resumeTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<ModeListener>();

  constructor(
    private readonly scheduler: PollingScheduler | null,
    private readonly defaultResumeAfterMinutes: number | null = 60,
  ) {
    this.state = { mode: 'realtime', acquiring: false, since: new Date().toISOString(), resumeAt: null };
  }

  get current(): ModeState {
    return { ...this.state };
  }

  get isRealtime(): boolean {
    return this.state.mode === 'realtime';
  }

  /** Applies the current mode to the scheduler. Call once the app is ready. */
  start(): void {
    this.apply();
  }

  /** Stops everything for shutdown, without changing the mode. */
  shutdown(): void {
    this.clearResumeTimer();
    this.scheduler?.stop();
  }

  setMode(mode: Mode, resumeAfterMinutes: number | null = this.defaultResumeAfterMinutes): ModeState {
    this.clearResumeTimer();
    const paused = mode !== 'realtime';
    const resumeAt = paused && resumeAfterMinutes ? new Date(Date.now() + resumeAfterMinutes * 60_000) : null;
    if (resumeAt) {
      this.resumeTimer = setTimeout(() => this.setMode('realtime'), resumeAt.getTime() - Date.now());
      this.resumeTimer.unref();
    }

    const changed = mode !== this.state.mode;
    this.state = {
      mode,
      acquiring: false,
      since: changed ? new Date().toISOString() : this.state.since,
      resumeAt: resumeAt?.toISOString() ?? null,
    };
    this.apply();
    for (const listener of this.listeners) listener(this.current);
    return this.current;
  }

  /** Runs an ingest as soon as possible, if acquisition is on (e.g. after a scope change). */
  refreshNow(): void {
    if (this.isRealtime) this.scheduler?.trigger();
  }

  /** Observer: called after every mode change. Returns an unsubscribe function. */
  subscribe(listener: ModeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private apply(): void {
    if (this.isRealtime) this.scheduler?.start();
    else this.scheduler?.stop();
    this.state.acquiring = this.isRealtime && this.scheduler !== null;
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }
}
