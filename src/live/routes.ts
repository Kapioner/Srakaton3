import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Row } from '../db/database.js';
import {
  CONFIDENCE_CLASSES,
  MODES,
  REGIONS,
  SENSORS,
  WINDOWS,
  isValidBBox,
  type BBox,
  type ConfidenceClass,
  type IngestScope,
  type Mode,
} from './domain.js';
import type { SituationService } from './forecast/situationService.js';
import type { IngestService } from './ingestService.js';
import type { AcquisitionController } from './modeController.js';
import type { ReportService } from './reportService.js';
import { PUBLIC_COLUMNS, type HotspotFilter, type HotspotRepository, type IngestStateRepository } from './repository.js';

export interface LiveRoutesDeps {
  hotspots: HotspotRepository;
  state: IngestStateRepository;
  ingest: IngestService;
  situation: SituationService;
  report: ReportService;
  acquisition: AcquisitionController;
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
    pollIntervalSeconds: { type: 'integer', minimum: 10, maximum: 86_400 },
  },
} as const;

const spatialQuery = {
  bbox: { type: 'string', description: 'west,south,east,north' },
} as const;

/** HTTP surface of the live feature. Mounted under a prefix so it sits beside the archive API. */
export const liveRoutes: FastifyPluginAsync<LiveRoutesDeps> = async (app: FastifyInstance, deps) => {
  const { hotspots, state, ingest, situation, report, acquisition } = deps;

  // --- Mode: realtime acquisition vs. frozen data (archive browsing, forecast) ---------------

  app.get('/mode', async () => acquisition.current);

  app.put<{ Body: { mode: Mode; resumeAfterMinutes?: number | null } }>(
    '/mode',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: MODES },
            resumeAfterMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 1440 },
          },
        },
      },
    },
    async (request) => acquisition.setMode(request.body.mode, request.body.resumeAfterMinutes),
  );

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
        pollIntervalSeconds: request.body.pollIntervalSeconds ?? current.pollIntervalSeconds,
      };
      if (scope.bbox && !isValidBBox(scope.bbox)) {
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'bbox must be [west, south, east, north] within ±180/±90' });
      }
      await ingest.changeScope(scope);
      // In realtime the new scope is fetched right away, in the background; when paused it waits.
      if (acquisition.current.acquiring) acquisition.refreshNow();
      else if (acquisition.isRealtime) void ingest.run().catch(() => undefined); // polling disabled by config
      return reply.code(202).send({ ...scope, acquiring: acquisition.current.acquiring });
    },
  );

  // --- Ingest control -----------------------------------------------------------------------

  app.post('/ingest', async (request, reply) => {
    if (!acquisition.isRealtime) {
      return reply.code(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: `Acquisition is paused in "${acquisition.current.mode}" mode. PUT /mode {"mode":"realtime"} first.`,
      });
    }
    return ingest.run();
  });

  app.get('/status', async () => ({
    mode: acquisition.current,
    running: ingest.isRunning,
    scope: await state.getScope(),
    lastRun: await state.lastRun(),
    store: await hotspots.stats(),
  }));

  // --- Harmonized hotspots ------------------------------------------------------------------

  app.get<{
    Querystring: {
      bbox?: string;
      from?: string;
      to?: string;
      since?: string;
      minConfidence?: ConfidenceClass;
      format?: 'json' | 'geojson' | 'csv';
      limit?: number;
    };
  }>(
    '/hotspots',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...spatialQuery,
            from: { type: 'string', format: 'date-time', description: 'acquisition time ≥' },
            to: { type: 'string', format: 'date-time', description: 'acquisition time ≤' },
            since: { type: 'string', format: 'date-time', description: 'cursor from a previous response' },
            minConfidence: { type: 'string', enum: CONFIDENCE_CLASSES },
            format: { type: 'string', enum: ['json', 'geojson', 'csv'], default: 'json' },
            limit: { type: 'integer', minimum: 1, maximum: 50_000, default: 5_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { from, to, since, minConfidence, format, limit } = request.query;
      // Read the cursor first and pin the query to it, so rows stored in between are not lost.
      const cursor = await hotspots.cursor();
      const filter: HotspotFilter = {
        bbox: parseBBox(request.query.bbox),
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        ingestedAfter: since ? new Date(since) : undefined,
        ingestedUntil: cursor ? new Date(cursor) : undefined,
        minConfidence,
      };

      if (format === 'csv') {
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="live_hotspots_${Date.now()}.csv"`)
          .send(Readable.from(toCsv(hotspots.stream(filter))));
      }

      const rows = await hotspots.find(filter, limit!);
      const meta = { count: rows.length, truncated: rows.length === limit, cursor, incremental: Boolean(since) };
      if (format === 'geojson') {
        return { type: 'FeatureCollection', metadata: meta, features: rows.map(toPointFeature) };
      }
      return { ...meta, hotspots: rows };
    },
  );

  // --- Push notifications (Server-Sent Events) ----------------------------------------------

  /**
   * Events:
   *  - `hello` on connect: `{ cursor, mode }`,
   *  - `ingest` after every run: `{ status, inserted, finishedAt, cursor }`; when `inserted > 0`
   *    the map fetches `/hotspots?format=geojson&since=<cursor>` and the panel reloads `/report`,
   *  - `mode` after every mode change: the ModeState.
   */
  app.get('/events', async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // keeps CORS headers set by the plugin
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('hello', { cursor: await hotspots.cursor(), mode: acquisition.current });
    const unsubscribeIngest = ingest.subscribe(async (run) => {
      send('ingest', { status: run.status, inserted: run.inserted, finishedAt: run.finishedAt, cursor: await hotspots.cursor() });
    });
    const unsubscribeMode = acquisition.subscribe((mode) => send('mode', mode));
    // Comments keep proxies from closing an idle connection.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeIngest();
      unsubscribeMode();
    });
  });

  // --- Report for the area selected in the frontend ----------------------------------------

  app.get<{ Querystring: { bbox?: string; hours: number } }>(
    '/report',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...spatialQuery,
            hours: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
          },
        },
      },
    },
    (request) => report.report({ bbox: parseBBox(request.query.bbox), hours: request.query.hours }),
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

function toPointFeature(row: Row) {
  const { latitude, longitude, ...properties } = row;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties };
}

async function* toCsv(chunks: AsyncIterable<Row[]>): AsyncGenerator<string> {
  yield PUBLIC_COLUMNS.join(',') + '\n';
  for await (const rows of chunks) {
    if (rows.length) yield rows.map((row) => PUBLIC_COLUMNS.map((column) => row[column] ?? '').join(',')).join('\n') + '\n';
  }
}
