// ETL step 2: normalized hotspots -> calibration + harmonized daily aggregate.
//
//   npm run etl:harmonize                                   # dataset in data/parquet, countries from config
//   npm run etl:harmonize -- --output data/parquet_global --countries '*'
//   npm run etl:harmonize -- --recalibrate                  # refit k factors even if they exist
//
// Reads  <OUTPUT_DIR>/hotspots/**            (from etl:normalize)
// Writes <OUTPUT_DIR>/calibration/k.parquet  k(country, satellite, FRP class) + params.json
//        <OUTPUT_DIR>/harmonized/year=YYYY/part_0.parquet
//          one row per 0.1 deg cell x day: h (Aqua-equivalent fire cell-days, the harmonized count),
//          h_modis / h_viirs (same estimate from one sensor family only), n_modis / n_viirs (raw detections).
// Method and its validation: see harmonization.ts.

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig } from './config.ts';
import { HARMONIZATION as P, fitCalibration, harmonizedDailySql, harmonizedMonthlySql, satellitesSql } from './harmonization.ts';

const args = process.argv.slice(2);
const recalibrate = args.includes('--recalibrate');
const monthlyOnly = args.includes('--monthly-only'); // only rebuild harmonized_monthly from the existing daily aggregate
const cfg = loadConfig(args.filter((a) => a !== '--recalibrate' && a !== '--monthly-only'));

const fwd = (p: string) => p.replaceAll('\\', '/');
const lit = (s: string) => `'${fwd(s).replaceAll("'", "''")}'`;
const exists = (p: string) => stat(p).then(() => true, () => false);

const hotspotsGlob = path.join(cfg.outputDir, 'hotspots', '**', '*.parquet');
const calibDir = path.join(cfg.outputDir, 'calibration');
const kFile = path.join(calibDir, 'k.parquet');
const paramsFile = path.join(calibDir, 'params.json');
const harmonizedDir = path.join(cfg.outputDir, 'harmonized');
const stagingDir = path.join(cfg.outputDir, '.staging_harmonize');

const t0 = performance.now();
await mkdir(stagingDir, { recursive: true });
const instance = await DuckDBInstance.create(':memory:', {
  temp_directory: fwd(path.join(stagingDir, 'duckdb_tmp')),
  preserve_insertion_order: 'false',
  ...(cfg.threads ? { threads: String(cfg.threads) } : {}),
});
const conn = await instance.connect();
const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, any>[];

const countryFilter = cfg.countries === '*' ? 'true' : `country IN (${cfg.countries.map((c) => `'${c.replaceAll("'", "''")}'`).join(', ')})`;
await conn.run(`
  CREATE VIEW hotspots AS
  SELECT * FROM read_parquet(${lit(hotspotsGlob)}, hive_partitioning = true) WHERE ${countryFilter}`);
await conn.run(`CREATE TABLE sats AS ${satellitesSql}`);
// The API reads satellite availability from this small file instead of scanning all hotspots (slow on world data).
await mkdir(calibDir, { recursive: true });
await conn.run(`COPY sats TO ${lit(path.join(calibDir, 'satellites.parquet'))} (FORMAT parquet)`);
console.log('Satellites:');
console.table(await rows(`SELECT satellite, sensor, first_date::VARCHAR AS first, last_date::VARCHAR AS last FROM sats`));

// ---- Monthly aggregate (cell x month), rebuilt from the daily aggregate - cheap, always for all years ----
const monthlyDir = path.join(cfg.outputDir, 'harmonized_monthly');
async function buildMonthly() {
  const tm = performance.now();
  const staged = path.join(stagingDir, 'monthly');
  await rm(staged, { recursive: true, force: true });
  await conn.run(`COPY (${harmonizedMonthlySql(path.join(harmonizedDir, '**', '*.parquet'))}) TO ${lit(staged)}
    (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (year), FILENAME_PATTERN 'part_{i}')`);
  await rm(monthlyDir, { recursive: true, force: true });
  await rename(staged, monthlyDir);
  const [s] = await rows(`SELECT count(*) AS n FROM read_parquet(${lit(path.join(monthlyDir, '**', '*.parquet'))})`);
  console.log(`Monthly aggregate: ${s.n} cell-months -> ${monthlyDir} (${((performance.now() - tm) / 1000).toFixed(1)} s)`);
}
if (monthlyOnly) {
  await buildMonthly();
  await rm(stagingDir, { recursive: true, force: true });
  conn.closeSync();
  process.exit(0);
}

// ---- Calibration (refit when asked, missing, params changed, or new countries appeared) ----
const paramsKey = JSON.stringify(P);
let needCalib = recalibrate || !(await exists(kFile)) || !(await exists(paramsFile));
if (!needCalib) {
  const saved = JSON.parse(await readFile(paramsFile, 'utf8'));
  needCalib = JSON.stringify(saved.params) !== paramsKey;
  if (!needCalib) {
    const missing = await rows(`
      SELECT count(*) AS n FROM (SELECT DISTINCT country FROM hotspots)
      WHERE country NOT IN (SELECT DISTINCT country FROM read_parquet(${lit(kFile)}))`);
    needCalib = Number(missing[0].n) > 0;
  }
}

if (needCalib) {
  const tc = performance.now();
  await fitCalibration(conn, P);
  await mkdir(calibDir, { recursive: true });
  await conn.run(`COPY calib TO ${lit(kFile)} (FORMAT parquet)`);
  await writeFile(paramsFile, JSON.stringify({ params: P, fittedAt: new Date().toISOString() }, null, 2));
  console.log(`Calibration fitted in ${((performance.now() - tc) / 1000).toFixed(1)} s -> ${kFile}`);
} else {
  await conn.run(`CREATE TABLE calib AS SELECT * FROM read_parquet(${lit(kFile)})`);
  console.log(`Calibration loaded from ${kFile}`);
}
console.log(`k per satellite and FRP class (global; classes split at ${P.frpEdges.join('/')} MW):`);
console.table(
  await rows(`
    PIVOT (SELECT satellite, 'c' || cls AS cls, round(any_value(k_global), 2) AS k FROM calib WHERE k_global IS NOT NULL GROUP BY ALL)
    ON cls USING any_value(k) ORDER BY satellite`),
);

// ---- Harmonized daily aggregate, one year at a time ----
const years = (await rows(`SELECT DISTINCT year::INTEGER AS y FROM hotspots ORDER BY y`))
  .map((r) => Number(r.y))
  .filter((y) => cfg.years === '*' || cfg.years.has(y));

for (const year of years) {
  const ty = performance.now();
  const staged = path.join(stagingDir, `year_${year}.parquet`);
  await conn.run(`COPY (${harmonizedDailySql(`year = ${year}`, P)}) TO ${lit(staged)} (FORMAT parquet, COMPRESSION zstd)`);
  const target = path.join(harmonizedDir, `year=${year}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await rename(staged, path.join(target, 'part_0.parquet'));
  const [s] = await rows(`SELECT count(*) AS n, round(sum(h), 1) AS h FROM read_parquet(${lit(path.join(target, 'part_0.parquet'))})`);
  console.log(`${year}  ${String(s.n).padStart(9)} cell-days  h=${String(s.h).padStart(10)}  ${((performance.now() - ty) / 1000).toFixed(1)} s`);
}
await buildMonthly();
await rm(stagingDir, { recursive: true, force: true });

// ---- Validation: in the overlap, MODIS-only and VIIRS-only estimates must agree ----
const harmonizedGlob = path.join(harmonizedDir, '**', '*.parquet');
const yearly = await rows(`
  SELECT year, round(sum(n_modis + n_viirs)) AS raw_detections, round(sum(h)) AS h,
         round(sum(h_modis)) AS h_modis, round(sum(h_viirs)) AS h_viirs
  FROM read_parquet(${lit(harmonizedGlob)}, hive_partitioning = true)
  WHERE ${countryFilter}
  GROUP BY year ORDER BY year`);
console.table(yearly);
const both = yearly.filter((r) => Number(r.h_modis) > 0 && Number(r.h_viirs) > 0);
if (both.length) {
  const err = both.reduce((s, r) => s + Math.abs(Math.log(Number(r.h_viirs) / Number(r.h_modis))), 0) / both.length;
  console.log(`Sensor agreement in overlap (${both.length} years): mean |ln(h_viirs / h_modis)| = ${err.toFixed(3)} (~${(err * 100).toFixed(0)} %)`);
}
console.log(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
conn.closeSync();
