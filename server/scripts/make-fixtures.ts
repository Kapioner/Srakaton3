// Regenerates server/fixtures/*.json (and export.csv) from the ETL Parquet output.
//
//   npm run etl:all             # first, so data/parquet exists
//   npm run fixtures -w server
//
// Fixtures cover the whole dataset (no bbox) so the frontend can be built before the real queries exist.
// The queries here are a first draft of stage 3 and can be moved into src/queries/ later.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXPORT_COLUMNS, FIRE_UNIT, type CalibrationFactor, type MetaResponse } from '../../shared/api.ts';
import { calibrationFile, config, parquetGlob, REPO_ROOT } from '../src/config.ts';
import { query } from '../src/db.ts';

const OUT = path.join(REPO_ROOT, 'server', 'fixtures');
const HZ = `read_parquet('${parquetGlob('harmonized')}', hive_partitioning = true)`;
const HS = `read_parquet('${parquetGlob('hotspots')}', hive_partitioning = true)`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const round = (v: unknown, d = 1) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);

async function dump(name: string, body: unknown) {
  const file = path.join(OUT, name);
  await writeFile(file, JSON.stringify(body, null, 1) + '\n');
  console.log(`${name.padEnd(14)} ${(JSON.stringify(body).length / 1024).toFixed(0)} KB`);
}

const [range] = await query(`
  SELECT min(acq_date)::VARCHAR AS "from", max(acq_date)::VARCHAR AS "to",
         min(year)::INT AS y0, max(year)::INT AS y1
  FROM ${HZ} WHERE year >= 2001`);
const y0 = Number(range.y0);
const y1 = Number(range.y1);
// Year 2000 holds only a few weeks of Terra data; the calendar starts at the first full year.
const FULL = `year BETWEEN ${y0} AND ${y1}`;
const Q = { bbox: null, from: String(range.from), to: String(range.to) };

// ---- meta ----
const params = JSON.parse(
  await (await import('node:fs/promises')).readFile(path.join(config.parquetDir, 'calibration', 'params.json'), 'utf8'),
).params;
const [bbox] = await query(`SELECT min(longitude) a, min(latitude) b, max(longitude) c, max(latitude) d FROM ${HS} WHERE type = 0`);
const countries = (await query(`SELECT DISTINCT country FROM ${HZ} ORDER BY 1`)).map((r) => String(r.country));
const satellites = await query(`
  SELECT satellite, any_value(sensor) AS sensor, min(acq_date)::VARCHAR AS "from", max(acq_date)::VARCHAR AS "to"
  FROM ${HS} GROUP BY satellite ORDER BY min(acq_date)`);
const factors = (await query(`
  SELECT satellite, cls::INT AS cls, avg(k) AS k FROM read_parquet('${calibrationFile}')
  WHERE k IS NOT NULL GROUP BY ALL ORDER BY satellite, cls`)) as unknown as CalibrationFactor[];
const yearlyAll = await query(`
  SELECT year::INT AS year, sum(h) AS h, sum(h_modis) AS hm, sum(h_viirs) AS hv,
         sum(n_modis)::INT AS nm, sum(n_viirs)::INT AS nv
  FROM ${HZ} WHERE ${FULL} GROUP BY year ORDER BY year`);
const both = yearlyAll.filter((r) => Number(r.hm) > 0 && Number(r.hv) > 0);
const meta: MetaResponse = {
  dateRange: { from: Q.from, to: Q.to },
  bbox: [round(bbox.a, 4)!, round(bbox.b, 4)!, round(bbox.c, 4)!, round(bbox.d, 4)!],
  countries,
  satellites: satellites as unknown as MetaResponse['satellites'],
  harmonization: {
    unit: FIRE_UNIT,
    reference: params.reference,
    fineGridDeg: params.fineGridDeg,
    outGridDeg: params.outGridDeg,
    frpEdges: params.frpEdges,
    factors: factors.map((f) => ({ ...f, k: round(f.k, 3)! })),
    sensorAgreement: both.length
      ? {
          years: both.length,
          meanAbsLogRatio: round(both.reduce((s, r) => s + Math.abs(Math.log(Number(r.hv) / Number(r.hm))), 0) / both.length, 3)!,
        }
      : null,
  },
};
await dump('meta.json', meta);

// ---- calendar (month x year, metric h) ----
const cal = await query(`
  WITH grid AS (SELECT y, m FROM range(${y0}, ${y1 + 1}) a(y), range(1, 13) b(m)),
  v AS (SELECT year::INT AS y, month(acq_date)::INT AS m, sum(h) AS v FROM ${HZ} WHERE ${FULL} GROUP BY ALL),
  c AS (SELECT g.y, g.m, coalesce(v.v, 0) AS v FROM grid g LEFT JOIN v USING (y, m))
  SELECT y, m, v, avg(v) OVER (PARTITION BY m) AS mean, stddev_pop(v) OVER (PARTITION BY m) AS sd,
         min(v) OVER (PARTITION BY m) AS mn, max(v) OVER (PARTITION BY m) AS mx,
         rank() OVER (PARTITION BY m ORDER BY v DESC) AS rnk
  FROM c ORDER BY y, m`);
await dump('calendar.json', {
  query: { ...Q, granularity: 'month', metric: 'h' },
  unit: FIRE_UNIT,
  cells: cal.map((r) => ({
    year: Number(r.y),
    month: Number(r.m),
    value: round(r.v),
    anomaly: Number(r.mean) > 0 ? round(Number(r.v) / Number(r.mean), 2) : null,
    rank: num(r.rnk),
  })),
  baseline: cal
    .filter((r) => Number(r.y) === y0)
    .map((r) => ({ month: Number(r.m), mean: round(r.mean), std: round(r.sd), min: round(r.mn), max: round(r.mx) })),
  baselineYears: [y0, y1],
});

// ---- summary (whole dataset; the peak year compared with all years) ----
const [tot] = await query(`SELECT sum(h) AS h, sum(n_modis + n_viirs)::INT AS raw, count(DISTINCT acq_date)::INT AS days FROM ${HZ} WHERE ${FULL}`);
const [peakDay] = await query(`SELECT acq_date::VARCHAR AS d, sum(h) AS v FROM ${HZ} WHERE ${FULL} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
const peakMonth = [...cal].sort((a, b) => Number(b.v) - Number(a.v))[0];
const byYear = [...yearlyAll].sort((a, b) => Number(b.h) - Number(a.h));
const meanYear = Number(tot.h) / yearlyAll.length;
await dump('summary.json', {
  query: Q,
  unit: FIRE_UNIT,
  total: round(tot.h),
  rawDetections: Number(tot.raw),
  activeDays: Number(tot.days),
  peakDay: { date: String(peakDay.d), value: round(peakDay.v) },
  peakMonth: { year: Number(peakMonth.y), month: Number(peakMonth.m), value: round(peakMonth.v) },
  peakYear: { year: Number(byYear[0].year), value: round(byYear[0].h) },
  comparison: {
    periodValue: round(byYear[0].h),
    baselineMean: round(meanYear),
    ratio: round(Number(byYear[0].h) / meanYear, 2),
    rank: 1,
    outOf: yearlyAll.length,
    baselineYears: [y0, y1],
  },
});

// ---- series (yearly: harmonized vs raw) ----
await dump('series.json', {
  query: { ...Q, by: 'year' },
  unit: FIRE_UNIT,
  points: yearlyAll.map((r) => ({
    year: Number(r.year),
    h: round(r.h),
    hModis: round(r.hm),
    hViirs: round(r.hv),
    nModis: Number(r.nm),
    nViirs: Number(r.nv),
  })),
});

// ---- grid (August 2023, 0.1 deg) ----
const G = { from: '2023-08-01', to: '2023-08-31' };
const grid = await query(`
  SELECT lon::DOUBLE AS lon, lat::DOUBLE AS lat, sum(h) AS h, sum(n_modis + n_viirs)::INT AS n, count(DISTINCT acq_date)::INT AS days
  FROM ${HZ} WHERE acq_date BETWEEN '${G.from}' AND '${G.to}' GROUP BY 1, 2 ORDER BY h DESC`);
await dump('grid.json', {
  type: 'FeatureCollection',
  query: { bbox: null, ...G, res: 0.1 },
  features: grid.map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(r.lon), Number(r.lat)] },
    properties: { h: round(r.h, 2), detections: Number(r.n), activeDays: Number(r.days) },
  })),
});

// ---- points (22 Aug 2023, the Evros fire peak) ----
const P = { from: '2023-08-22', to: '2023-08-22', limit: 400 };
const points = await query(`
  SELECT longitude, latitude, acq_date::VARCHAR AS d, acq_time, sensor, satellite, confidence, frp, daynight
  FROM ${HS} WHERE type = 0 AND acq_date = '${P.from}' ORDER BY frp DESC NULLS LAST LIMIT ${P.limit + 1}`);
await dump('points.json', {
  type: 'FeatureCollection',
  query: { bbox: null, ...P },
  truncated: points.length > P.limit,
  features: points.slice(0, P.limit).map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(r.longitude), Number(r.latitude)] },
    properties: {
      date: String(r.d),
      time: String(r.acq_time),
      sensor: r.sensor,
      satellite: r.satellite,
      confidence: r.confidence,
      frp: num(r.frp),
      daynight: r.daynight,
    },
  })),
});

// ---- export.csv (same day, first 200 rows) ----
const csvFile = path.join(OUT, 'export.csv').replaceAll('\\', '/');
await query(`
  COPY (SELECT ${EXPORT_COLUMNS.join(', ')} FROM ${HS}
        WHERE type = 0 AND acq_date = '${P.from}' ORDER BY acq_time, latitude LIMIT 200)
  TO '${csvFile}' (HEADER)`);
console.log('export.csv     200 rows');
