import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Row } from '../db/database.js';
import {
  CONFIDENCE_CLASSES,
  REGIONS,
  SENSORS,
  WINDOWS,
  isValidBBox,
  type BBox,
  type ConfidenceClass,
  type IngestScope,
} from './domain.js';
import type { SituationService } from './forecast/situationService.js';
import type { IngestService } from './ingestService.js';
import { PUBLIC_COLUMNS, type HotspotFilter, type HotspotRepository, type IngestStateRepository } from './repository.js';
import type { PollingScheduler } from './scheduler.js';

export interface LiveRoutesDeps {
  hotspots: HotspotRepository;
  state: IngestStateRepository;
  ingest: IngestService;
  situation: SituationService;
  scheduler: PollingScheduler | null;
}

const scopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['region', 'sensors', 'window'],
  properties: {
    region: { type: 'string', enum: REGIONS },
    sensors: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: SENSORS } },
    window: { type: 'string', enum: WINDOWS },
    bbox: { type: ['array', 'null'], minItems: 4, maxItems: 4, items: { type: 'number' } },
    pollIntervalMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
  },
} as const;

const spatialQuery = {
  bbox: { type: 'string', description: 'west,south,east,north' },
} as const;

/** HTTP surface of the live feature. Mounted under a prefix so it sits beside the archive API. */
export const liveRoutes: FastifyPluginAsync<LiveRoutesDeps> = async (app: FastifyInstance, deps) => {
  const { hotspots, state, ingest, situation, scheduler } = deps;

  // --- Ingest scope (what is pulled from FIRMS) ---------------------------------------------

  app.get('/scope/options', async () => ({ regions: REGIONS, sensors: SENSORS, windows: WINDOWS }));

  app.get('/scope', () => state.getScope());

  app.put<{ Body: Partial<IngestScope> & Pick<IngestScope, 'region' | 'sensors' | 'window'> }>(
    '/scope',
    { schema: { body: scopeSchema } },
    async (request, reply) => {
      const current = await state.getScope();
      const scope: IngestScope = {
        region: request.body.region,
        sensors: request.body.sensors,
        window: request.body.window,
        bbox: request.body.bbox ?? null,
        pollIntervalMinutes: request.body.pollIntervalMinutes ?? current.pollIntervalMinutes,
      };
      if (scope.bbox && !isValidBBox(scope.bbox)) {
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'bbox must be [west, south, east, north] within ±180/±90' });
      }
      await ingest.changeScope(scope);
      // Refresh in the background; the client polls /status.
      if (scheduler) scheduler.trigger();
      else void ingest.run().catch(() => undefined);
      return reply.code(202).send(scope);
    },
  );

  // --- Ingest control -----------------------------------------------------------------------

  app.post('/ingest', async () => ingest.run());

  app.get('/status', async () => ({
    running: ingest.isRunning,
    scope: await state.getScope(),
    lastRun: await state.lastRun(),
    store: await hotspots.stats(),
  }));

  // --- Harmonized hotspots ------------------------------------------------------------------

  app.get<{ Querystring: { bbox?: string; from?: string; to?: string; minConfidence?: ConfidenceClass; format?: string; limit?: number } }>(
    '/hotspots',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...spatialQuery,
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            minConfidence: { type: 'string', enum: CONFIDENCE_CLASSES },
            format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
            limit: { type: 'integer', minimum: 1, maximum: 50_000, default: 5_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { from, to, minConfidence, format, limit } = request.query;
      const filter: HotspotFilter = {
        bbox: parseBBox(request.query.bbox),
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        minConfidence,
      };
      if (format === 'csv') {
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="live_hotspots_${Date.now()}.csv"`)
          .send(Readable.from(toCsv(hotspots.stream(filter))));
      }
      const rows = await hotspots.find(filter, limit!);
      return { count: rows.length, truncated: rows.length === limit, hotspots: rows };
    },
  );

  // --- Current situation and forecast -------------------------------------------------------

  app.get<{ Querystring: { bbox?: string; hours: number; limit: number } }>(
    '/situation',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...spatialQuery,
            hours: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
          },
        },
      },
    },
    (request) =>
      situation.situation({
        bbox: parseBBox(request.query.bbox),
        lookbackHours: request.query.hours,
        limit: request.query.limit,
      }),
  );

  app.get<{ Querystring: { bbox?: string; lookbackHours: number; horizons: string; limit: number } }>(
    '/forecast',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...spatialQuery,
            lookbackHours: { type: 'integer', minimum: 6, maximum: 168, default: 48 },
            horizons: { type: 'string', pattern: '^\\d{1,2}(,\\d{1,2}){0,5}$', default: '6,12,24' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        },
      },
    },
    (request) =>
      situation.forecast({
        bbox: parseBBox(request.query.bbox),
        lookbackHours: request.query.lookbackHours,
        horizonsHours: request.query.horizons.split(',').map(Number).filter((h) => h > 0),
        limit: request.query.limit,
      }),
  );
};

class BadRequest extends Error {
  readonly statusCode = 400;
}

function parseBBox(raw: string | undefined): BBox | null {
  if (!raw) return null;
  const bbox = raw.split(',').map(Number);
  if (!isValidBBox(bbox)) throw new BadRequest('bbox must be "west,south,east,north" within ±180/±90');
  return bbox;
}

async function* toCsv(chunks: AsyncIterable<Row[]>): AsyncGenerator<string> {
  yield PUBLIC_COLUMNS.join(',') + '\n';
  for await (const rows of chunks) {
    if (rows.length) yield rows.map((row) => PUBLIC_COLUMNS.map((column) => row[column] ?? '').join(',')).join('\n') + '\n';
  }
}
