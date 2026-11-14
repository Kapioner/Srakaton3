// Live (near-real-time) fire feature, mounted into the main API server under /api/live.
//
// Ported from the `API_backend` branch (see README there): it keeps pulling the public FIRMS active-fire
// files (24h/48h/7d, no key), stores them in its own DuckDB file (LIVE_DB_PATH, default
// data/live/live.duckdb) in the ETL's hotspot schema, and serves the current situation, a report for an
// area and a short-term movement forecast. The archive (ETL Parquet in OUTPUT_DIR) and live rows are read
// through one view, `hotspots_all`; days the archive already covers come from the archive.
//
// `app.ts` (buildApp) is the same wiring as a standalone app; the tests in server/test/live use it.
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import { HotspotCatalog } from './db/catalog.js';
import { Database } from './db/database.js';
import { migrate } from './db/schema.js';
import { loadEtlParams } from './etl.js';
import { ActiveFireFeedSource } from './live/firms/source.js';
import { CentroidDriftPredictor } from './live/forecast/predictor.js';
import { SituationService } from './live/forecast/situationService.js';
import { IngestService } from './live/ingestService.js';
import { AcquisitionController } from './live/modeController.js';
import { ReportService } from './live/reportService.js';
import { HotspotRepository, IngestStateRepository } from './live/repository.js';
import { liveRoutes } from './live/routes.js';
import { PollingScheduler } from './live/scheduler.js';

/** Registers /api/live/* on an existing Fastify app (CORS and compression are already registered there). */
export async function registerLive(app: FastifyInstance): Promise<void> {
  const config = loadConfig();
  const db = await Database.open(config.liveDbPath);
  await migrate(db);
  const catalog = new HotspotCatalog(db, config.archiveDir);
  await catalog.refresh();

  const hotspots = new HotspotRepository(db);
  const state = new IngestStateRepository(db);
  const source = new ActiveFireFeedSource(config.firmsBaseUrl, config.tmpDir);
  const ingest = new IngestService(source, hotspots, state, catalog, config.retentionDays, app.log);
  const situation = new SituationService(hotspots, new CentroidDriftPredictor());
  const scheduler = config.pollingEnabled
    ? new PollingScheduler(
        () => ingest.run(),
        async () => (await state.getScope()).pollIntervalSeconds * 1000,
      )
    : null;
  const acquisition = new AcquisitionController(scheduler, config.pauseResumeMinutes);
  const etl = await loadEtlParams(config.etlDir, app.log);
  const report = new ReportService(db, state, () => acquisition.current, etl);

  await app.register(liveRoutes, { prefix: '/api/live', hotspots, state, ingest, situation, report, acquisition, catalog });

  app.addHook('onReady', async () => acquisition.start());
  app.addHook('onClose', async () => {
    await acquisition.shutdown();
    db.close();
  });
  app.log.info(
    `live feed: ${config.liveDbPath} | archive ${config.archiveDir} | polling ${config.pollingEnabled ? 'on' : 'off'}`,
  );
}
