import type { IngestScope, Sensor } from './domain.js';
import type { HotspotSource } from './firms/source.js';
import type { HotspotRepository, IngestRun, IngestStateRepository } from './repository.js';

export interface SensorOutcome {
  sensor: Sensor;
  status: 'ingested' | 'unchanged' | 'failed';
  inserted: number;
  error?: string;
}

interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export type IngestListener = (run: IngestRun) => void;

/** Pulls the current scope from FIRMS into DuckDB. One run at a time. */
export class IngestService {
  private running: Promise<IngestRun> | null = null;
  private readonly listeners = new Set<IngestListener>();

  constructor(
    private readonly source: HotspotSource,
    private readonly hotspots: HotspotRepository,
    private readonly state: IngestStateRepository,
    private readonly retentionDays: number,
    private readonly log: Logger,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Starts a run, or joins the one already in progress. */
  run(): Promise<IngestRun> {
    this.running ??= this.execute().finally(() => (this.running = null));
    return this.running;
  }

  /** Observer: called after every finished run. Returns an unsubscribe function. */
  subscribe(listener: IngestListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replaces the scope; the next run downloads everything afresh. */
  async changeScope(scope: IngestScope): Promise<void> {
    await this.state.saveScope(scope, new Date());
    this.source.reset();
  }

  private async execute(): Promise<IngestRun> {
    const startedAt = new Date();
    const scope = await this.state.getScope();
    const outcomes: SensorOutcome[] = [];

    // Sequential on purpose: a single DuckDB writer, and we stay polite to FIRMS.
    for (const sensor of scope.sensors) {
      outcomes.push(await this.ingestSensor(sensor, scope));
    }
    await this.hotspots.purgeOlderThan(new Date(Date.now() - this.retentionDays * 86_400_000));

    const failed = outcomes.filter((o) => o.status === 'failed').length;
    const run: IngestRun = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: failed === 0 ? 'ok' : failed === outcomes.length ? 'failed' : 'partial',
      inserted: outcomes.reduce((sum, o) => sum + o.inserted, 0),
      details: { scope, outcomes },
    };
    await this.state.recordRun(run);
    this.log.info({ status: run.status, inserted: run.inserted }, 'live ingest finished');
    for (const listener of this.listeners) {
      try {
        listener(run);
      } catch (error) {
        this.log.error({ err: error }, 'ingest listener failed');
      }
    }
    return run;
  }

  private async ingestSensor(sensor: Sensor, scope: IngestScope): Promise<SensorOutcome> {
    try {
      const feed = await this.source.download(sensor, scope.region, scope.window);
      if (!feed) return { sensor, status: 'unchanged', inserted: 0 };
      try {
        const inserted = await this.hotspots.ingestCsv(feed.filePath, sensor, scope.bbox, new Date());
        return { sensor, status: 'ingested', inserted };
      } finally {
        feed.dispose();
      }
    } catch (error) {
      this.log.error({ sensor, err: error }, 'live ingest failed for sensor');
      return { sensor, status: 'failed', inserted: 0, error: (error as Error).message };
    }
  }
}
