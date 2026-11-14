import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { HealthResponse, MetaResponse, RegionsResponse } from '../../../shared/api.ts';
import { config, REPO_ROOT } from '../config.ts';
import { dataset, getMeta, getRegions, requireParquet } from '../dataset.ts';
import { query } from '../db.ts';
import { parseCommon, parseEnum, parseNumber } from '../params.ts';
import * as q from '../queries.ts';

const FIXTURES_DIR = path.join(REPO_ROOT, 'server', 'fixtures');

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, name), 'utf8')) as T;
}

/** Fixtures ignore the filters: they show the response shape with real Greece numbers. */
async function fixture(reply: FastifyReply, name: string) {
  const body = await readFixture<Record<string, unknown>>(name);
  return reply.header('x-data-source', 'fixtures').send(body);
}

/** Runs the parquet query, or serves the fixture when the server is in fixtures mode. */
async function serve<T>(reply: FastifyReply, fixtureName: string, run: () => Promise<T>) {
  const ds = await dataset();
  if (ds.source === 'fixtures') return fixture(reply, fixtureName);
  await requireParquet();
  const result = await run();
  return reply.header('x-data-source', 'parquet').send(result);
}

export async function apiRoutes(app: FastifyInstance) {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    const [row] = await query<{ version: string }>('SELECT version() AS version');
    const ds = await dataset();
    return {
      ok: !(ds.source === 'parquet' && ds.reason),
      duckdb: row.version,
      source: ds.source,
      reason: ds.reason,
      parquetDir: config.parquetDir,
      limits: {
        memoryLimit: config.duckdb.memoryLimit,
        threads: config.duckdb.threads,
        queryTimeoutMs: config.limits.queryTimeoutMs,
        gridMaxCells: config.limits.gridMaxCells,
        exportMaxRows: config.limits.exportMaxRows,
      },
    };
  });

  app.get('/api/meta', async (_req, reply) => {
    const ds = await dataset();
    if (ds.source === 'fixtures') {
      const meta = await readFixture<Omit<MetaResponse, 'source'>>('meta.json');
      return reply.header('x-data-source', 'fixtures').send({ ...meta, source: 'fixtures' } satisfies MetaResponse);
    }
    await requireParquet();
    return reply.header('x-data-source', 'parquet').send(await getMeta());
  });

  app.get('/api/regions', async (_req, reply): Promise<RegionsResponse> => {
    const ds = await dataset();
    if (ds.source === 'fixtures') {
      const meta = await readFixture<MetaResponse>('meta.json');
      reply.header('x-data-source', 'fixtures');
      return { source: 'fixtures', regions: meta.countries.map((country) => ({ country, bbox: meta.bbox, h: 0 })) };
    }
    await requireParquet();
    reply.header('x-data-source', 'parquet');
    return { source: 'parquet', regions: await getRegions() };
  });

  app.get('/api/calendar', async (req, reply) => {
    const raw = req.query as Record<string, unknown>;
    const p = parseCommon(raw);
    const granularity = parseEnum('granularity', raw.granularity, ['month', 'day'] as const, 'month');
    const metric = parseEnum('metric', raw.metric, ['h', 'h_modis', 'h_viirs', 'raw'] as const, 'h');
    return serve(reply, 'calendar.json', () => q.calendar(p, granularity, metric));
  });

  app.get('/api/summary', async (req, reply) => {
    const p = parseCommon(req.query as Record<string, unknown>);
    return serve(reply, 'summary.json', () => q.summary(p));
  });

  app.get('/api/series', async (req, reply) => {
    const raw = req.query as Record<string, unknown>;
    const p = parseCommon(raw);
    const by = parseEnum('by', raw.by, ['year', 'month'] as const, 'year');
    return serve(reply, 'series.json', () => q.series(p, by));
  });

  app.get('/api/grid', async (req, reply) => {
    const raw = req.query as Record<string, unknown>;
    const p = parseCommon(raw);
    const res = parseNumber('res', raw.res, 0.1, 0.1, 5);
    return serve(reply, 'grid.json', () => q.grid(p, res));
  });

  app.get('/api/points', async (req, reply) => {
    const raw = req.query as Record<string, unknown>;
    const p = parseCommon(raw);
    const limit = parseNumber('limit', raw.limit, 5_000, 1, config.limits.pointsMax);
    return serve(reply, 'points.json', () => q.points(p, limit));
  });

  app.get('/api/export.csv', async (req, reply) => {
    const p = parseCommon(req.query as Record<string, unknown>);
    const ds = await dataset();
    reply.type('text/csv; charset=utf-8');
    if (ds.source === 'fixtures') {
      return reply
        .header('x-data-source', 'fixtures')
        .header('content-disposition', 'attachment; filename="hotspots_sample.csv"')
        .send(createReadStream(path.join(FIXTURES_DIR, 'export.csv')));
    }
    await requireParquet();
    const { stream, filename, cap } = await q.exportCsv(p);
    return reply
      .header('x-data-source', 'parquet')
      .header('x-row-limit', String(cap))
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(stream);
  });
}
