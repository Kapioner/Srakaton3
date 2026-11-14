// ETL step 1b: import FIRMS "Archive Download" global CSVs (no country in the file) into the normalized dataset.
//
//   npm run etl:import-global -- --input data --output data/parquet_global
//
// Files: fire_archive_<code>_<id>.csv (standard, has `type`) and fire_nrt_<code>_<id>.csv (near-real-time, NO `type`),
// <code> = M-C61 (MODIS), SV-C2 (S-NPP), J1V-C2 (NOAA-20), J2V-C2 (NOAA-21). They can sit anywhere under --input.
//
// What it adds on top of etl:normalize:
//   * country: taken from where FIRMS itself put hotspots in the same 0.1 deg cell in previous years
//     (fallback 1 deg cell, else 'Unknown'). Only used for partitioning/calibration - queries filter by coordinates.
//   * type for NRT rows: inferred from history - a ~1 km cell (0.01 deg) whose past detections were mostly
//     static sources / volcano / offshore gets that type, everything else 0 (vegetation fire).
//     The inference is scored on the archive part, where the true type is known.
// The years found in the files are REPLACED completely (all countries) - re-run after downloading fresh NRT data.
// Do not mix this with per-country CSVs of the same year.

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig } from './config.ts';

const cfg = loadConfig([...process.argv.slice(2), ...(process.argv.includes('--countries') ? [] : ['--countries', '*'])]);
const fwd = (p: string) => p.replaceAll('\\', '/');
const lit = (s: string) => `'${fwd(s).replaceAll("'", "''")}'`;
const exists = (p: string) => stat(p).then(() => true, () => false);

const CODES: Record<string, string> = { 'M-C61': 'modis', 'SV-C2': 'viirs-snpp', 'J1V-C2': 'viirs-jpss1', 'J2V-C2': 'viirs-jpss2' };
const FILE_RE = /^fire_(archive|nrt)_(M-C61|SV-C2|J1V-C2|J2V-C2)_\d+\.csv$/;
const HISTORY_YEARS = 8;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

const files: { path: string; kind: 'archive' | 'nrt'; source: string }[] = [];
for await (const f of walk(cfg.inputDir)) {
  const m = path.basename(f).match(FILE_RE);
  if (m) files.push({ path: fwd(f), kind: m[1] as 'archive' | 'nrt', source: CODES[m[2]] });
}
if (!files.length) {
  console.error(`No fire_archive_*/fire_nrt_* files under ${cfg.inputDir}`);
  process.exit(1);
}
console.log(`Global import: ${files.length} files -> ${cfg.outputDir}`);
for (const f of files) console.log(`  ${f.kind.padEnd(7)} ${f.source.padEnd(12)} ${path.relative(cfg.inputDir, f.path)}`);

const hotspotsDir = path.join(cfg.outputDir, 'hotspots');
const stagingDir = path.join(cfg.outputDir, '.staging_import');
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });
const conn = await (await DuckDBInstance.create(':memory:', {
  temp_directory: fwd(path.join(stagingDir, 'duckdb_tmp')),
  preserve_insertion_order: 'false',
})).connect();
const q = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, any>[];
const t0 = performance.now();
const lap = (label: string, t: number) => console.log(`${label} (${((performance.now() - t) / 1000).toFixed(1)} s)`);

// ---- 1. raw rows (archive has `type`, NRT does not) ----
const COLS = `'latitude': 'DOUBLE', 'longitude': 'DOUBLE', 'brightness': 'DOUBLE', 'scan': 'DOUBLE', 'track': 'DOUBLE',
  'acq_date': 'DATE', 'acq_time': 'VARCHAR', 'satellite': 'VARCHAR', 'instrument': 'VARCHAR', 'confidence': 'VARCHAR',
  'version': 'VARCHAR', 'bright_t31': 'DOUBLE', 'frp': 'DOUBLE', 'daynight': 'VARCHAR'`;
const read = (kind: 'archive' | 'nrt') => {
  const list = files.filter((f) => f.kind === kind);
  if (!list.length) return null;
  const cols = kind === 'archive' ? `{${COLS}, 'type': 'TINYINT'}` : `{${COLS}}`;
  return `SELECT *, ${kind === 'archive' ? '' : 'NULL::TINYINT AS type, '}'${kind}' AS kind
          FROM read_csv([${list.map((f) => lit(f.path)).join(', ')}], header = true, columns = ${cols}, filename = true, auto_detect = false)`;
};
let t = performance.now();
await conn.run(`CREATE TABLE raw AS ${[read('archive'), read('nrt')].filter(Boolean).join(' UNION ALL BY NAME ')}`);
const years = (await q(`SELECT DISTINCT year(acq_date)::INT AS y FROM raw ORDER BY y`)).map((r) => Number(r.y));
const [{ n: rawRows }] = await q(`SELECT count(*) AS n FROM raw`);
lap(`Read ${Number(rawRows).toLocaleString('en')} rows, years ${years.join(', ')}`, t);

// ---- 2. lookups from history (years before the imported ones) ----
t = performance.now();
const histFrom = Math.min(...years) - HISTORY_YEARS;
await conn.run(`
  CREATE VIEW hist AS SELECT latitude, longitude, country, type
  FROM read_parquet(${lit(path.join(hotspotsDir, '**', '*.parquet'))}, hive_partitioning = true)
  WHERE year BETWEEN ${histFrom} AND ${Math.min(...years) - 1}`);
await conn.run(`CREATE TABLE cc10 AS SELECT floor(latitude * 10)::INT AS ci, floor(longitude * 10)::INT AS cj, mode(country) AS country FROM hist GROUP BY ALL`);
await conn.run(`CREATE TABLE cc1 AS SELECT floor(latitude)::INT AS ci, floor(longitude)::INT AS cj, mode(country) AS country FROM hist GROUP BY ALL`);
await conn.run(`
  CREATE TABLE ct AS SELECT ti, tj, t FROM (
    SELECT floor(latitude * 100)::INT AS ti, floor(longitude * 100)::INT AS tj, mode(type) AS t FROM hist GROUP BY ALL
  ) WHERE t <> 0`);
const [lk] = await q(`SELECT (SELECT count(*) FROM cc10) AS c10, (SELECT count(*) FROM cc1) AS c1, (SELECT count(*) FROM ct) AS ct`);
lap(`Lookups from ${histFrom}-${Math.min(...years) - 1}: ${lk.c10} country cells (0.1 deg), ${lk.c1} (1 deg), ${lk.ct} non-vegetation cells (0.01 deg)`, t);

// ---- 3. enrich: country + inferred type ----
t = performance.now();
await conn.run(`
  CREATE TABLE enriched AS
  SELECT r.*,
         coalesce(c10.country, c1.country, 'Unknown') AS country,
         coalesce(ct.t, 0)::TINYINT AS type_inferred
  FROM raw r
  LEFT JOIN cc10 c10 ON c10.ci = floor(r.latitude * 10)::INT AND c10.cj = floor(r.longitude * 10)::INT
  LEFT JOIN cc1 c1 ON c1.ci = floor(r.latitude)::INT AND c1.cj = floor(r.longitude)::INT
  LEFT JOIN ct ON ct.ti = floor(r.latitude * 100)::INT AND ct.tj = floor(r.longitude * 100)::INT`);
await conn.run('DROP TABLE raw');
lap('Country and type assigned', t);

const [cs] = await q(`
  SELECT count(*) FILTER (WHERE country = 'Unknown') AS unknown, count(*) AS n FROM enriched`);
console.log(`Country: ${(100 * Number(cs.unknown) / Number(cs.n)).toFixed(2)}% of rows without a known country ('Unknown')`);
// Score the type inference where the truth is known (archive rows).
const [ts] = await q(`
  SELECT count(*) FILTER (WHERE type <> 0 AND type_inferred <> 0) AS tp,
         count(*) FILTER (WHERE type = 0 AND type_inferred <> 0) AS fp,
         count(*) FILTER (WHERE type <> 0 AND type_inferred = 0) AS fn,
         count(*) FILTER (WHERE type = type_inferred) AS same, count(*) AS n
  FROM enriched WHERE kind = 'archive'`);
if (Number(ts.n)) {
  const tp = Number(ts.tp), fp = Number(ts.fp), fn = Number(ts.fn);
  console.log(`Type inference on archive rows: accuracy ${(100 * Number(ts.same) / Number(ts.n)).toFixed(1)}%, ` +
    `non-vegetation precision ${(100 * tp / (tp + fp)).toFixed(1)}%, recall ${(100 * tp / (tp + fn)).toFixed(1)}%`);
}

// ---- 4. normalized schema (same columns as etl:normalize) and write, year by year ----
const normalized = `
  SELECT latitude, longitude, acq_date,
    lpad(trim(acq_time), 4, '0') AS acq_time,
    acq_date + to_minutes((CAST(lpad(trim(acq_time), 4, '0')[1:2] AS INTEGER) * 60 + CAST(lpad(trim(acq_time), 4, '0')[3:4] AS INTEGER))::BIGINT) AS acq_datetime,
    CASE WHEN f.source = 'modis' THEN 'MODIS' ELSE 'VIIRS' END AS sensor,
    CASE f.source WHEN 'viirs-snpp' THEN 'S-NPP' WHEN 'viirs-jpss1' THEN 'NOAA-20' WHEN 'viirs-jpss2' THEN 'NOAA-21'
      ELSE CASE upper(trim(satellite)) WHEN 'TERRA' THEN 'Terra' WHEN 'T' THEN 'Terra' WHEN 'AQUA' THEN 'Aqua' WHEN 'A' THEN 'Aqua' ELSE trim(satellite) END END AS satellite,
    CASE WHEN f.source = 'modis' THEN
           CASE WHEN TRY_CAST(confidence AS INTEGER) < 30 THEN 'low' WHEN TRY_CAST(confidence AS INTEGER) <= 80 THEN 'nominal'
                WHEN TRY_CAST(confidence AS INTEGER) > 80 THEN 'high' END
         ELSE CASE lower(trim(confidence)) WHEN 'l' THEN 'low' WHEN 'n' THEN 'nominal' WHEN 'h' THEN 'high' END
    END AS confidence,
    trim(confidence) AS confidence_raw,
    frp, brightness AS bt_mir, bright_t31 AS bt_tir, scan, track, round(scan * track, 4) AS pixel_km2,
    upper(trim(daynight)) AS daynight,
    coalesce(type, type_inferred)::TINYINT AS type,
    trim(version) AS version,
    f.source AS source,
    year(acq_date)::INTEGER AS year,
    country
  FROM (SELECT *, CASE ${Object.entries(CODES).map(([code, src]) => `WHEN filename LIKE '%_${code}_%' THEN '${src}'`).join(' ')} END AS source FROM enriched) f`;

// Directory renames on Windows can fail briefly while antivirus scans freshly written files.
async function renameRetry(from: string, to: string) {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (i >= 10 || (err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

for (const year of years) {
  t = performance.now();
  const staged = path.join(stagingDir, `year_${year}`);
  await conn.run(`
    COPY (SELECT * FROM (${normalized}) WHERE year = ${year} ORDER BY country, acq_date, latitude, longitude)
    TO ${lit(staged)} (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (year, country), FILENAME_PATTERN 'part_{i}', ROW_GROUP_SIZE 122880)`);
  const target = path.join(hotspotsDir, `year=${year}`);
  if (await exists(target)) console.log(`  replacing existing ${path.relative(cfg.outputDir, target)}`);
  await rm(target, { recursive: true, force: true });
  await renameRetry(path.join(staged, `year=${year}`), target);
  const [s] = await q(`SELECT count(*) AS n, count(DISTINCT country) AS c FROM read_parquet(${lit(path.join(target, '**', '*.parquet'))})`);
  lap(`${year}  ${Number(s.n).toLocaleString('en')} rows, ${s.c} countries`, t);
}
await rm(stagingDir, { recursive: true, force: true });
lap('Done', t0);
conn.closeSync();
