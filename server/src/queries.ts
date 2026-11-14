// Archive queries over the ETL Parquet output. Every query filters by coordinates and date (never by
// country file names) and adds a `year` predicate so DuckDB only opens the matching year partitions.
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type {
  Bbox,
  CalendarCell,
  CalendarResponse,
  GridResponse,
  MetaResponse,
  Metric,
  MonthBaseline,
  PointsResponse,
  ReportResponse,
  SeriesResponse,
  SummaryResponse,
} from '../../shared/api.ts';
import { EXPORT_COLUMNS, FIRE_UNIT } from '../../shared/api.ts';
import { config, fwd, paths } from './config.ts';
import { getMeta } from './dataset.ts';
import { existsSync } from 'node:fs';
import { exec, query } from './db.ts';
import { BadRequest, type CommonParams } from './params.ts';

// ---- filters ------------------------------------------------------------------------------------------

export interface Filters {
  bbox: Bbox | null;
  from: string;
  to: string;
}

/** Fills missing dates with the dataset range and clamps the request to it. */
export async function resolveFilters(p: CommonParams): Promise<{ f: Filters; meta: MetaResponse }> {
  const meta = await getMeta();
  const from = p.from && p.from > meta.dateRange.from ? p.from : meta.dateRange.from;
  const to = p.to && p.to < meta.dateRange.to ? p.to : meta.dateRange.to;
  if (from > to) throw new BadRequest(`No data in the requested dates (dataset covers ${meta.dateRange.from} to ${meta.dateRange.to})`);
  return { f: { bbox: p.bbox, from, to }, meta };
}

const year = (d: string) => Number(d.slice(0, 4));

/** WHERE clause for the harmonized view (columns lat, lon, acq_date, year). */
function hzWhere(f: Filters, from = f.from, to = f.to): string {
  const parts = [`acq_date BETWEEN DATE '${from}' AND DATE '${to}'`, `year BETWEEN ${year(from)} AND ${year(to)}`];
  if (f.bbox) {
    const [x0, y0, x1, y1] = f.bbox;
    parts.push(`lon BETWEEN ${x0} AND ${x1}`, `lat BETWEEN ${y0} AND ${y1}`);
  }
  return parts.join(' AND ');
}

/** WHERE clause for the hotspots view: vegetation fires only (type 0). */
function hsWhere(f: Filters): string {
  const parts = ['type = 0', `acq_date BETWEEN DATE '${f.from}' AND DATE '${f.to}'`, `year BETWEEN ${year(f.from)} AND ${year(f.to)}`];
  if (f.bbox) {
    const [x0, y0, x1, y1] = f.bbox;
    parts.push(`longitude BETWEEN ${x0} AND ${x1}`, `latitude BETWEEN ${y0} AND ${y1}`);
  }
  return parts.join(' AND ');
}

const METRIC_SQL: Record<Metric, string> = {
  h: 'sum(h)',
  h_modis: 'sum(h_modis)',
  h_viirs: 'sum(h_viirs)',
  raw: 'sum(n_modis + n_viirs)',
};

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** First year to show by default: skip a leading year that holds only a few weeks of data. */
function firstFullYear(meta: MetaResponse): number {
  const start = meta.dateRange.from;
  return Number(start.slice(5, 7)) <= 2 ? year(start) : year(start) + 1;
}

/** Months in which a sensor family did not fly have no MODIS-only / VIIRS-only value (null, not 0). */
function familyFlies(meta: MetaResponse, metric: Metric, y: number, m: number): boolean {
  if (metric !== 'h_modis' && metric !== 'h_viirs') return true;
  const sensor = metric === 'h_modis' ? 'MODIS' : 'VIIRS';
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const monthEnd = `${y}-${String(m).padStart(2, '0')}-31`;
  return meta.satellites.some((s) => s.sensor === sensor && s.from <= monthEnd && s.to >= monthStart);
}

// ---- /api/calendar ------------------------------------------------------------------------------------

export async function calendar(p: CommonParams, granularity: 'month' | 'day', metric: Metric): Promise<CalendarResponse> {
  const { f, meta } = await resolveFilters(p);
  const y0 = p.from ? year(f.from) : Math.max(year(f.from), firstFullYear(meta));
  const y1 = year(f.to);
  const yf = { ...f, from: p.from ? f.from : `${y0}-01-01` };

  if (granularity === 'day') {
    const days = (Date.parse(f.to) - Date.parse(yf.from)) / 86_400_000;
    if (days > 4000) throw new BadRequest('Daily calendar is limited to about 10 years; narrow the date range');
    const rows = await query(
      `SELECT year(acq_date)::INT AS y, month(acq_date)::INT AS m, day(acq_date)::INT AS d, ${METRIC_SQL[metric]} AS v
       FROM harmonized WHERE ${hzWhere(yf)} GROUP BY ALL ORDER BY ALL`,
    );
    const cells: CalendarCell[] = rows.map((r) => ({ year: Number(r.y), month: Number(r.m), day: Number(r.d), value: r1(n(r.v)), anomaly: null, rank: null }));
    return { query: { bbox: f.bbox, from: yf.from, to: f.to, granularity, metric }, unit: unitOf(metric), cells, baseline: [], baselineYears: [y0, y1] };
  }

  const rows = await query(
    `SELECT year(acq_date)::INT AS y, month(acq_date)::INT AS m, ${METRIC_SQL[metric]} AS v
     FROM harmonized WHERE ${hzWhere(yf)} GROUP BY ALL`,
  );
  const byKey = new Map(rows.map((r) => [`${r.y}-${r.m}`, n(r.v)]));
  const dataEnd = meta.dateRange.to.slice(0, 7);

  const cells: CalendarCell[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      const future = ym > dataEnd;
      const flies = familyFlies(meta, metric, y, m);
      const value = future || !flies ? null : (byKey.get(`${y}-${m}`) ?? 0);
      cells.push({ year: y, month: m, value: r1(value), anomaly: null, rank: null });
    }
  }

  const baseline: MonthBaseline[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = cells.filter((c) => c.month === m && c.value !== null);
    const values = month.map((c) => c.value as number);
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const std = values.length ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) : 0;
    baseline.push({ month: m, mean: r1(mean)!, std: r1(std)!, min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0 });
    const sorted = [...values].sort((a, b) => b - a);
    for (const c of month) {
      c.anomaly = mean > 0 ? Math.round(((c.value as number) / mean) * 100) / 100 : null;
      c.rank = sorted.indexOf(c.value as number) + 1;
    }
  }

  return { query: { bbox: f.bbox, from: yf.from, to: f.to, granularity, metric }, unit: unitOf(metric), cells, baseline, baselineYears: [y0, y1] };
}

function unitOf(metric: Metric): string {
  return metric === 'raw' ? 'raw detections (not comparable across years)' : FIRE_UNIT;
}

// ---- /api/summary -------------------------------------------------------------------------------------

export async function summary(p: CommonParams): Promise<SummaryResponse> {
  const { f, meta } = await resolveFilters(p);
  const where = hzWhere(f);

  const [[tot], [peakDay], months] = await Promise.all([
    query(`SELECT coalesce(sum(h), 0) AS h, coalesce(sum(n_modis + n_viirs), 0) AS raw, count(DISTINCT acq_date) AS days FROM harmonized WHERE ${where}`),
    query(`SELECT acq_date::VARCHAR AS d, sum(h) AS v FROM harmonized WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`),
    query(`SELECT year(acq_date)::INT AS y, month(acq_date)::INT AS m, sum(h) AS v FROM harmonized WHERE ${where} GROUP BY ALL`),
  ]);

  const peakMonth = months.reduce<(typeof months)[number] | null>((a, r) => (!a || Number(r.v) > Number(a.v) ? r : a), null);
  const years = new Map<number, number>();
  for (const r of months) years.set(Number(r.y), (years.get(Number(r.y)) ?? 0) + Number(r.v));
  const peakYear = [...years.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    query: { bbox: f.bbox, from: f.from, to: f.to },
    unit: FIRE_UNIT,
    total: r1(Number(tot.h))!,
    rawDetections: Number(tot.raw),
    activeDays: Number(tot.days),
    peakDay: peakDay ? { date: String(peakDay.d), value: r1(Number(peakDay.v))! } : null,
    peakMonth: peakMonth ? { year: Number(peakMonth.y), month: Number(peakMonth.m), value: r1(Number(peakMonth.v))! } : null,
    peakYear: peakYear ? { year: peakYear[0], value: r1(peakYear[1])! } : null,
    comparison: await samePeriodComparison(f, meta),
  };
}

/**
 * "How does this period compare?": the same calendar window (e.g. 1-31 Aug) in every other year of the
 * dataset, for the same region. Only for windows up to one year long.
 */
async function samePeriodComparison(f: Filters, meta: MetaResponse): Promise<SummaryResponse['comparison']> {
  const days = (Date.parse(f.to) - Date.parse(f.from)) / 86_400_000;
  const y0 = firstFullYear(meta);
  const y1 = year(meta.dateRange.to);
  const empty = { periodValue: 0, baselineMean: 0, ratio: null, rank: 1, outOf: 1, baselineYears: [year(f.from), year(f.to)] as [number, number] };
  if (days > 366) {
    const [row] = await query(`SELECT coalesce(sum(h), 0) AS v FROM harmonized WHERE ${hzWhere(f)}`);
    return { ...empty, periodValue: r1(Number(row.v))! };
  }

  // Shift the window by k years, keeping only windows that lie inside the dataset.
  const kMin = y0 - year(f.from);
  const kMax = y1 - year(f.to);
  const shifts: string[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const d0 = `${year(f.from) + k}${f.from.slice(4)}`;
    const d1 = `${year(f.to) + k}${f.to.slice(4)}`;
    if (d1 > meta.dateRange.to) continue;
    // 29 Feb in a non-leap year: TRY_CAST gives NULL, use 28 Feb instead.
    shifts.push(`(${k}, coalesce(TRY_CAST('${d0}' AS DATE), DATE '${d0.slice(0, 8)}28'), coalesce(TRY_CAST('${d1}' AS DATE), DATE '${d1.slice(0, 8)}28'))`);
  }
  if (shifts.length < 2) return empty;

  const bboxWhere = f.bbox ? `AND lon BETWEEN ${f.bbox[0]} AND ${f.bbox[2]} AND lat BETWEEN ${f.bbox[1]} AND ${f.bbox[3]}` : '';
  const rows = await query(`
    WITH w(k, d0, d1) AS (VALUES ${shifts.join(', ')})
    SELECT w.k, year(w.d0)::INT AS y, coalesce(sum(hz.h), 0) AS v
    FROM w LEFT JOIN harmonized hz
      ON hz.acq_date BETWEEN w.d0 AND w.d1 AND hz.year BETWEEN year(w.d0) AND year(w.d1) ${bboxWhere}
    GROUP BY ALL ORDER BY w.k`);

  const current = rows.find((r) => Number(r.k) === 0);
  // The selected window itself may lie outside the comparable years (e.g. a partial first year).
  const value = current
    ? Number(current.v)
    : Number((await query(`SELECT coalesce(sum(h), 0) AS v FROM harmonized WHERE ${hzWhere(f)}`))[0].v);
  const others = rows.filter((r) => Number(r.k) !== 0).map((r) => Number(r.v));
  const mean = others.reduce((a, b) => a + b, 0) / Math.max(1, others.length);
  const rank = 1 + others.filter((v) => v > value).length;
  return {
    periodValue: r1(value)!,
    baselineMean: r1(mean)!,
    ratio: mean > 0 ? Math.round((value / mean) * 100) / 100 : null,
    rank,
    outOf: rows.length,
    baselineYears: [Number(rows[0].y), Number(rows[rows.length - 1].y)],
  };
}

// ---- /api/series --------------------------------------------------------------------------------------

export async function series(p: CommonParams, by: 'year' | 'month'): Promise<SeriesResponse> {
  const { f, meta } = await resolveFilters(p);
  const yf = p.from ? f : { ...f, from: `${Math.max(year(f.from), firstFullYear(meta))}-01-01` };
  const monthCol = by === 'month' ? ', month(acq_date)::INT AS m' : '';
  const rows = await query(
    `SELECT year(acq_date)::INT AS y${monthCol}, sum(h) AS h, sum(h_modis) AS hm, sum(h_viirs) AS hv,
            coalesce(sum(n_modis), 0) AS nm, coalesce(sum(n_viirs), 0) AS nv
     FROM harmonized WHERE ${hzWhere(yf)} GROUP BY ALL ORDER BY ALL`,
  );
  const byKey = new Map(rows.map((r) => [by === 'month' ? `${r.y}-${r.m}` : `${r.y}`, r]));
  const points: SeriesResponse['points'] = [];
  for (let y = year(yf.from); y <= year(yf.to); y++) {
    for (const m of by === 'month' ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [undefined]) {
      const r = byKey.get(m ? `${y}-${m}` : `${y}`);
      const flies = (metric: Metric) => (m ? familyFlies(meta, metric, y, m) : [1, 6, 12].some((mm) => familyFlies(meta, metric, y, mm)));
      points.push({
        year: y,
        ...(m ? { month: m } : {}),
        h: r1(n(r?.h) ?? 0)!,
        hModis: flies('h_modis') ? r1(n(r?.hm) ?? 0) : null,
        hViirs: flies('h_viirs') ? r1(n(r?.hv) ?? 0) : null,
        nModis: Number(r?.nm ?? 0),
        nViirs: Number(r?.nv ?? 0),
      });
    }
  }
  return { query: { bbox: f.bbox, from: yf.from, to: f.to, by }, unit: FIRE_UNIT, points };
}

// ---- /api/grid ----------------------------------------------------------------------------------------

const GRID_STEPS = [0.1, 0.25, 0.5, 1, 2, 5];

export async function grid(p: CommonParams, requestedRes: number): Promise<GridResponse> {
  const { f } = await resolveFilters(p);
  const where = hzWhere(f);
  const max = config.limits.gridMaxCells;

  // How many 0.1 deg cells are active? Coarsen until the answer fits the limit (area scales with res^2).
  const [{ c }] = await query(`SELECT count(DISTINCT (cell_lat, cell_lon)) AS c FROM harmonized WHERE ${where}`);
  const active = Number(c);
  let res = GRID_STEPS.find((s) => s >= requestedRes) ?? requestedRes;
  while (active / (res / 0.1) ** 2 > max && res < GRID_STEPS[GRID_STEPS.length - 1]) {
    res = GRID_STEPS[GRID_STEPS.indexOf(res) + 1] ?? res * 2;
  }

  const rows = await query(`
    SELECT round((floor(lon::DOUBLE / ${res}) + 0.5) * ${res}, 4) AS x, round((floor(lat::DOUBLE / ${res}) + 0.5) * ${res}, 4) AS y,
           sum(h) AS h, sum(n_modis + n_viirs) AS det, count(DISTINCT acq_date) AS days
    FROM harmonized WHERE ${where}
    GROUP BY 1, 2 ORDER BY h DESC LIMIT ${max + 1}`);

  return {
    type: 'FeatureCollection',
    query: { bbox: f.bbox, from: f.from, to: f.to, res },
    truncated: rows.length > max,
    features: rows.slice(0, max).map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r.x), Number(r.y)] },
      properties: { h: Math.round(Number(r.h) * 100) / 100, detections: Number(r.det), activeDays: Number(r.days) },
    })),
  };
}

// ---- /api/points --------------------------------------------------------------------------------------

export async function points(p: CommonParams, limit: number): Promise<PointsResponse> {
  const { f } = await resolveFilters(p);
  const cap = Math.min(limit, config.limits.pointsMax);
  const rows = await query(`
    SELECT longitude, latitude, acq_date::VARCHAR AS d, acq_time, sensor, satellite, confidence, frp, daynight
    FROM hotspots WHERE ${hsWhere(f)} ORDER BY frp DESC NULLS LAST LIMIT ${cap + 1}`);
  return {
    type: 'FeatureCollection',
    query: { bbox: f.bbox, from: f.from, to: f.to, limit: cap },
    truncated: rows.length > cap,
    features: rows.slice(0, cap).map((r) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r.longitude), Number(r.latitude)] },
      properties: {
        date: String(r.d),
        time: String(r.acq_time),
        sensor: r.sensor as 'MODIS' | 'VIIRS',
        satellite: r.satellite as PointsResponse['features'][number]['properties']['satellite'],
        confidence: (r.confidence ?? null) as 'low' | 'nominal' | 'high' | null,
        frp: n(r.frp),
        daynight: r.daynight as 'D' | 'N',
      },
    })),
  };
}

// ---- /api/export.csv ----------------------------------------------------------------------------------

/**
 * Writes the search result to a temporary CSV with DuckDB (fast, constant memory) and streams that file.
 * The file is deleted when the response ends. Capped at EXPORT_MAX_ROWS rows.
 */
export async function exportCsv(p: CommonParams): Promise<{ stream: Readable; filename: string; cap: number }> {
  const { f } = await resolveFilters(p);
  const cap = config.limits.exportMaxRows;
  const file = path.join(os.tmpdir(), `firecal-export-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  await exec(
    `COPY (SELECT ${EXPORT_COLUMNS.join(', ')} FROM hotspots WHERE ${hsWhere(f)} ORDER BY acq_date, acq_time LIMIT ${cap})
     TO '${fwd(file)}' (HEADER, DELIMITER ',')`,
    Math.max(config.limits.queryTimeoutMs, 120_000),
  );
  const stream = createReadStream(file);
  const cleanup = () => void rm(file, { force: true });
  stream.on('close', cleanup);
  stream.on('error', cleanup);
  return { stream, filename: `hotspots_${f.from}_${f.to}.csv`, cap };
}

// ---- /api/report --------------------------------------------------------------------------------------

/**
 * Report data for a region. `hotspots` / `calibration` are table expressions so the fixtures script can
 * run the same SQL on read_parquet(...) directly.
 */
export async function buildReport(hotspots: string, calibration: string | null, bbox: Bbox | null, timeoutMs?: number) {
  const where = bbox ? `WHERE longitude BETWEEN ${bbox[0]} AND ${bbox[2]} AND latitude BETWEEN ${bbox[1]} AND ${bbox[3]}` : '';
  const rows = await query(
    `SELECT year::INT AS y, satellite AS s, type::INT AS t, count(*) AS n FROM ${hotspots} ${where} GROUP BY ALL ORDER BY ALL`,
    timeoutMs,
  );
  const sat = new Map<string, { year: number; satellite: ReportResponse['rawBySatellite'][number]['satellite']; n: number }>();
  const typ = new Map<string, { year: number; type: number; n: number }>();
  for (const r of rows) {
    const year = Number(r.y);
    const n = Number(r.n);
    const ks = `${year}|${r.s}`;
    const kt = `${year}|${r.t}`;
    sat.set(ks, { year, satellite: r.s as ReportResponse['rawBySatellite'][number]['satellite'], n: (sat.get(ks)?.n ?? 0) + n });
    typ.set(kt, { year, type: Number(r.t), n: (typ.get(kt)?.n ?? 0) + n });
  }
  const calib = calibration
    ? await query(`SELECT satellite, cls::INT AS cls, avg(k) AS k, sum(n_sat) AS ns, sum(n_ref) AS nr FROM ${calibration} WHERE k IS NOT NULL GROUP BY ALL ORDER BY ALL`)
    : [];
  return {
    rawBySatellite: [...sat.values()],
    byType: [...typ.values()],
    calibration: calib.map((r) => ({
      satellite: r.satellite as ReportResponse['calibration'][number]['satellite'],
      cls: Number(r.cls),
      k: Math.round(Number(r.k) * 1000) / 1000,
      nSat: Number(r.ns),
      nRef: Number(r.nr),
    })),
  };
}

// Full scans of the hotspots table: cache per region until the dataset changes (meta is rebuilt then).
const reportCache = new Map<string, Promise<ReportResponse>>();

export async function report(p: CommonParams): Promise<ReportResponse> {
  const meta = await getMeta();
  const key = `${meta.dateRange.from}|${meta.dateRange.to}|${meta.countries.length}|${p.bbox?.join(',') ?? 'all'}`;
  let hit = reportCache.get(key);
  if (!hit) {
    hit = (async () => {
      const calib = existsSync(paths.calibrationFile) ? `read_parquet('${fwd(paths.calibrationFile)}')` : null;
      const body = await buildReport('hotspots', calib, p.bbox, Math.max(config.limits.queryTimeoutMs, 120_000));
      return { query: { bbox: p.bbox }, ...body, frpEdges: meta.harmonization.frpEdges, reference: meta.harmonization.reference };
    })();
    hit.catch(() => reportCache.delete(key));
    if (reportCache.size > 30) reportCache.delete(reportCache.keys().next().value!);
    reportCache.set(key, hit);
  }
  return hit;
}
