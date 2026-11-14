// Which data the API serves, and the slow-to-compute facts about it (cached).
//
// The server reads the ETL output layout, whatever its size:
//   <OUTPUT_DIR>/hotspots/year=YYYY/country=Name/*.parquet   normalized detections
//   <OUTPUT_DIR>/harmonized/year=YYYY/*.parquet              0.1 deg cell x day aggregate
//   <OUTPUT_DIR>/calibration/k.parquet, params.json         harmonization factors
// Greece (dev) and the whole world only differ in OUTPUT_DIR. Views re-read the folder on every query,
// so years added by a new ETL run show up without a restart; cached metadata is refreshed when the
// set of partition folders changes.
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Bbox, CalibrationFactor, DataSource, MetaResponse, Region, Satellite, SatelliteInfo } from '../../shared/api.ts';
import { FIRE_UNIT } from '../../shared/api.ts';
import { config, fwd, paths, parquetGlob } from './config.ts';
import { exec, query } from './db.ts';

export class NoData extends Error {
  statusCode = 503;
}

export interface DatasetState {
  source: DataSource;
  /** Why the parquet dataset is not used (fixtures fallback, or forced parquet with no files). */
  reason: string | null;
}

const RECHECK_MS = 10_000;
/** Metadata on the world dataset may need a full scan the first time; allow it more time than a request. */
const WARMUP_TIMEOUT_MS = 5 * 60_000;

let state: { at: number; value: DatasetState } | null = null;
let viewsReady = false;

async function hasParquet(dir: string): Promise<boolean> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.parquet')) return true;
      if (entry.isDirectory() && (await hasParquet(path.join(dir, entry.name)))) return true;
    }
  } catch {
    // missing folder
  }
  return false;
}

/** Creates the views once; concurrent first requests share the same promise (DuckDB rejects parallel CREATE VIEW). */
let viewsPromise: Promise<void> | null = null;
function ensureViews(): Promise<void> {
  viewsPromise ??= createViews().catch((err) => {
    viewsPromise = null;
    throw err;
  });
  return viewsPromise;
}

async function createViews() {
  // union_by_name: partitions written by different ETL versions may differ in column order.
  await exec(`CREATE OR REPLACE VIEW harmonized AS
    SELECT * FROM read_parquet('${parquetGlob('harmonized')}', hive_partitioning = true, union_by_name = true)`);
  await exec(`CREATE OR REPLACE VIEW hotspots AS
    SELECT * FROM read_parquet('${parquetGlob('hotspots')}', hive_partitioning = true, union_by_name = true)`);
  monthlyReady = await hasParquet(paths.harmonizedMonthlyDir);
  if (monthlyReady) {
    await exec(`CREATE OR REPLACE VIEW harmonized_monthly AS
      SELECT * FROM read_parquet('${parquetGlob('harmonized_monthly')}', hive_partitioning = true, union_by_name = true)`);
  }
  viewsReady = true;
}

let monthlyReady = false;
/** True when the ETL's monthly aggregate exists: whole-month queries read it instead of the daily one. */
export const hasMonthly = () => monthlyReady;

/** Current data source; re-checked every few seconds so an ETL run is picked up without a restart. */
export async function dataset(): Promise<DatasetState> {
  if (state && Date.now() - state.at < RECHECK_MS) return state.value;
  let value: DatasetState;
  if (config.dataSource === 'fixtures') {
    value = { source: 'fixtures', reason: 'DATA_SOURCE=fixtures' };
  } else {
    const ok = (await hasParquet(paths.harmonizedDir)) && (await hasParquet(paths.hotspotsDir));
    if (ok) {
      if (!viewsReady) await ensureViews();
      value = { source: 'parquet', reason: null };
    } else {
      const reason = `No ETL output in ${config.parquetDir} (run: npm run etl:all)`;
      value = config.dataSource === 'parquet' ? { source: 'parquet', reason } : { source: 'fixtures', reason };
    }
  }
  state = { at: Date.now(), value };
  return value;
}

/** Throws a 503 when parquet is forced but missing; otherwise returns the state. */
export async function requireParquet(): Promise<void> {
  const s = await dataset();
  if (s.source === 'parquet' && s.reason) throw new NoData(s.reason);
}

// ---- cached metadata --------------------------------------------------------------------------------

/** Changes whenever a partition folder is added, removed or rewritten. */
async function signature(): Promise<string> {
  const parts: string[] = [];
  for (const dir of [paths.harmonizedDir, paths.hotspotsDir, path.dirname(paths.calibrationFile)]) {
    try {
      for (const name of (await readdir(dir)).sort()) {
        const s = await stat(path.join(dir, name));
        parts.push(`${name}:${s.mtimeMs}`);
      }
    } catch {
      parts.push(`${dir}:missing`);
    }
  }
  return parts.join('|');
}

interface Cached {
  sig: string;
  meta: Promise<MetaResponse>;
  regions: Promise<Region[]>;
}
let cache: Cached | null = null;

async function cached(): Promise<Cached> {
  const sig = await signature();
  if (!cache || cache.sig !== sig) {
    const meta = computeMeta();
    const regions = computeRegions();
    // A failed computation must not stay cached.
    meta.catch(() => cache?.sig === sig && (cache = null));
    regions.catch(() => cache?.sig === sig && (cache = null));
    cache = { sig, meta, regions };
  }
  return cache;
}

export async function getMeta(): Promise<MetaResponse> {
  return (await cached()).meta;
}

export async function getRegions(): Promise<Region[]> {
  return (await cached()).regions;
}

const num = (v: unknown) => Number(v);
const round = (v: unknown, d = 4) => Math.round(Number(v) * 10 ** d) / 10 ** d;

async function listCountries(): Promise<string[]> {
  const countries = new Set<string>();
  try {
    for (const year of await readdir(paths.hotspotsDir)) {
      if (!year.startsWith('year=')) continue;
      for (const c of await readdir(path.join(paths.hotspotsDir, year))) {
        if (c.startsWith('country=')) countries.add(c.slice('country='.length).replaceAll('_', ' '));
      }
    }
  } catch {
    // no hotspots folder
  }
  return [...countries].sort();
}

async function satellites(): Promise<SatelliteInfo[]> {
  // The ETL writes this small table during harmonize; older outputs fall back to a scan.
  const sql = existsSync(paths.satellitesFile)
    ? `SELECT satellite, sensor, first_date::VARCHAR AS "from", last_date::VARCHAR AS "to"
       FROM read_parquet('${fwd(paths.satellitesFile)}') ORDER BY first_date`
    : `SELECT satellite, any_value(sensor) AS sensor, min(acq_date)::VARCHAR AS "from", max(acq_date)::VARCHAR AS "to"
       FROM hotspots GROUP BY satellite ORDER BY min(acq_date)`;
  const rows = await query<{ satellite: Satellite; sensor: 'MODIS' | 'VIIRS'; from: string; to: string }>(sql, WARMUP_TIMEOUT_MS);
  return rows.map((r) => ({ satellite: r.satellite, sensor: r.sensor, from: r.from, to: r.to }));
}

async function computeMeta(): Promise<MetaResponse> {
  const [ext] = await query(
    `SELECT min(acq_date)::VARCHAR AS d0, max(acq_date)::VARCHAR AS d1,
            min(lon)::DOUBLE AS x0, min(lat)::DOUBLE AS y0, max(lon)::DOUBLE AS x1, max(lat)::DOUBLE AS y1
     FROM harmonized`,
    WARMUP_TIMEOUT_MS,
  );
  const params = existsSync(paths.paramsFile) ? JSON.parse(await readFile(paths.paramsFile, 'utf8')).params : {};
  const factors = existsSync(paths.calibrationFile)
    ? (
        await query<{ satellite: Satellite; cls: string; k: number }>(
          `SELECT satellite, cls::INT AS cls, avg(k) AS k FROM read_parquet('${fwd(paths.calibrationFile)}')
           WHERE k IS NOT NULL GROUP BY ALL ORDER BY satellite, cls`,
        )
      ).map((r): CalibrationFactor => ({ satellite: r.satellite, cls: num(r.cls), k: round(r.k, 3) }))
    : [];
  const yearly = await query<{ hm: number | null; hv: number | null }>(
    `SELECT sum(h_modis) AS hm, sum(h_viirs) AS hv FROM harmonized GROUP BY year`,
    WARMUP_TIMEOUT_MS,
  );
  const both = yearly.filter((r) => Number(r.hm) > 0 && Number(r.hv) > 0);
  const half = 0.05; // grid cell centres -> cell edges
  return {
    source: 'parquet',
    dateRange: { from: String(ext.d0), to: String(ext.d1) },
    bbox: [round(num(ext.x0) - half), round(num(ext.y0) - half), round(num(ext.x1) + half), round(num(ext.y1) + half)] as Bbox,
    countries: await listCountries(),
    satellites: await satellites(),
    harmonization: {
      unit: FIRE_UNIT,
      reference: params.reference ?? 'Aqua',
      fineGridDeg: params.fineGridDeg ?? 0.02,
      outGridDeg: params.outGridDeg ?? 0.1,
      frpEdges: params.frpEdges ?? [5, 10, 20, 40],
      factors,
      sensorAgreement: both.length
        ? {
            years: both.length,
            meanAbsLogRatio: round(both.reduce((s, r) => s + Math.abs(Math.log(Number(r.hv) / Number(r.hm))), 0) / both.length, 3),
          }
        : null,
    },
  };
}

async function computeRegions(): Promise<Region[]> {
  // Also the extent in 0..360 longitudes: for a country across the date line (Russia, Fiji, USA with the
  // Aleutians) that box is far narrower than -180..180, and MapLibre fits it fine with east > 180.
  const rows = await query(
    `SELECT country, min(lon)::DOUBLE AS x0, min(lat)::DOUBLE AS y0, max(lon)::DOUBLE AS x1, max(lat)::DOUBLE AS y1,
            min(CASE WHEN lon < 0 THEN lon + 360 ELSE lon END)::DOUBLE AS w0,
            max(CASE WHEN lon < 0 THEN lon + 360 ELSE lon END)::DOUBLE AS w1, sum(h) AS h
     FROM harmonized_monthly WHERE country IS NOT NULL GROUP BY country ORDER BY country`,
    WARMUP_TIMEOUT_MS,
  ).catch(() =>
    query(
      `SELECT country, min(lon)::DOUBLE AS x0, min(lat)::DOUBLE AS y0, max(lon)::DOUBLE AS x1, max(lat)::DOUBLE AS y1,
              min(CASE WHEN lon < 0 THEN lon + 360 ELSE lon END)::DOUBLE AS w0,
              max(CASE WHEN lon < 0 THEN lon + 360 ELSE lon END)::DOUBLE AS w1, sum(h) AS h
       FROM harmonized WHERE country IS NOT NULL GROUP BY country ORDER BY country`,
      WARMUP_TIMEOUT_MS,
    ),
  );
  return rows.map((r) => {
    // Use the 0..360 box only when it is clearly narrower (it ties for countries that never touch 0 or 180).
    const wraps = num(r.w1) - num(r.w0) + 1 < num(r.x1) - num(r.x0);
    let [x0, x1] = wraps ? [num(r.w0), num(r.w1)] : [num(r.x0), num(r.x1)];
    if (x0 >= 180) [x0, x1] = [x0 - 360, x1 - 360];
    return {
      country: String(r.country).replaceAll('_', ' '),
      bbox: [round(x0 - 0.05), round(num(r.y0) - 0.05), round(x1 + 0.05), round(num(r.y1) + 0.05)] as Bbox,
      h: round(r.h, 1),
    };
  });
}

/** Starts the slow metadata queries right after boot, so the first page load does not wait for them. */
export async function warmUp(log: (msg: string) => void) {
  const s = await dataset();
  if (s.source !== 'parquet' || s.reason) {
    log(`data source: fixtures${s.reason ? ` (${s.reason})` : ''}`);
    return;
  }
  const t0 = performance.now();
  try {
    const [meta, regions] = await Promise.all([getMeta(), getRegions()]);
    log(
      `data source: parquet ${config.parquetDir} | ${meta.dateRange.from}..${meta.dateRange.to} | ${regions.length} countries | ` +
        `metadata in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
  } catch (err) {
    log(`metadata warm-up failed: ${(err as Error).message}`);
  }
}
