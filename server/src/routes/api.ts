import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config, REPO_ROOT } from '../../../shared/config.ts';
import { query } from '../db.ts';
import { parseCommon, parseEnum, parseNumber } from '../params.ts';

const FIXTURES_DIR = path.join(REPO_ROOT, 'server', 'fixtures');

// Stage 0: every endpoint validates its parameters and answers from server/fixtures.
// Fixtures ignore the filters; they show the response shape with real Greece numbers.
// Stage 3 replaces `fixture()` with DuckDB queries from src/queries/.
async function fixture(reply: FastifyReply, name: string) {
  if (!config.useFixtures) {
    return reply.code(501).send({ error: 'Not implemented yet. Set USE_FIXTURES=1 to use fixtures.' });
  }
  const body = await readFile(path.join(FIXTURES_DIR, name), 'utf8');
  return reply.header('x-data-source', 'fixture').type('application/json').send(body);
}

export async function apiRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    const [row] = await query<{ version: string }>('SELECT version() AS version');
    const csvGlob = path.join(config.dataDir, 'modis', '*.csv').replaceAll('\\', '/');
    const [sample] = await query<{ n: string }>(`SELECT count(*) AS n FROM read_csv_auto('${csvGlob}')`);
    return { ok: true, duckdb: row.version, sampleModisRows: Number(sample.n), fixtures: config.useFixtures };
  });

  app.get('/api/meta', async (_req, reply) => fixture(reply, 'meta.json'));

  app.get('/api/calendar', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    parseCommon(q);
    parseEnum('granularity', q.granularity, ['month', 'day'] as const, 'month');
    parseEnum('metric', q.metric, ['harmonized', 'raw_points', 'raw_cells'] as const, 'harmonized');
    return fixture(reply, 'calendar.json');
  });

  app.get('/api/summary', async (req, reply) => {
    parseCommon(req.query as Record<string, unknown>);
    return fixture(reply, 'summary.json');
  });

  app.get('/api/series', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    parseCommon(q);
    parseEnum('by', q.by, ['year', 'month'] as const, 'year');
    return fixture(reply, 'series.json');
  });

  app.get('/api/grid', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    parseCommon(q);
    parseNumber('res', q.res, 0.1, 0.01, 1);
    return fixture(reply, 'grid.json');
  });

  app.get('/api/points', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    parseCommon(q);
    parseNumber('limit', q.limit, 50_000, 1, 200_000);
    return fixture(reply, 'points.json');
  });

  app.get('/api/export.csv', async (req, reply) => {
    parseCommon(req.query as Record<string, unknown>);
    if (!config.useFixtures) return reply.code(501).send({ error: 'Not implemented yet.' });
    return reply
      .header('x-data-source', 'fixture')
      .header('content-disposition', 'attachment; filename="hotspots.csv"')
      .type('text/csv; charset=utf-8')
      .send(createReadStream(path.join(FIXTURES_DIR, 'export.csv')));
  });
}
