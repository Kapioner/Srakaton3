import compress from '@fastify/compress';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { migrate } from './db/schema.js';
import { ActiveFireFeedSource, type HotspotSource } from './live/firms/source.js';
import { CentroidDriftPredictor } from './live/forecast/predictor.js';
import { SituationService } from './live/forecast/situationService.js';
import { IngestService } from './live/ingestService.js';
import { HotspotRepository, IngestStateRepository } from './live/repository.js';
import { liveRoutes } from './live/routes.js';
import { PollingScheduler } from './live/scheduler.js';

export interface AppOverrides {
  /** Replace the FIRMS source (tests, or a MAP_KEY-based implementation). */
  source?: HotspotSource;
  logger?: boolean;
}

/** Composition root: wires the live feature together and returns a ready Fastify app. */
export async function buildApp(config: AppConfig, db: Database, overrides: AppOverrides = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: overrides.logger ?? true });
  await app.register(cors);
  await app.register(compress);
  await migrate(db);

  const hotspots = new HotspotRepository(db);
  const state = new IngestStateRepository(db);
  const source = overrides.source ?? new ActiveFireFeedSource(config.firmsBaseUrl, config.tmpDir);
  const ingest = new IngestService(source, hotspots, state, config.retentionDays, app.log);
  const situation = new SituationService(hotspots, new CentroidDriftPredictor());
  const scheduler = config.pollingEnabled
    ? new PollingScheduler(
        () => ingest.run(),
        async () => (await state.getScope()).pollIntervalMinutes * 60_000,
      )
    : null;

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(liveRoutes, { prefix: '/api/live', hotspots, state, ingest, situation, scheduler });
  // The archive/calendar API registers here, next to the live feature, on the same Database.

  app.addHook('onReady', async () => scheduler?.start());
  app.addHook('onClose', async () => scheduler?.stop());
  return app;
}
