// ETL validation: data quality, harmonization quality and query speed, in one command.
//
//   npm run etl:validate                                              # dev dataset (Greece)
//   npm run etl:validate -- --output data/parquet_global --countries '*'
//   npm run etl:validate -- --output data/parquet_global --countries '*' --oos   # + out-of-sample calibration test (slow)
//
// Every check prints PASS / WARN / FAIL with a number; the full result is saved to data/reports/validate-<scope>.json.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { REPO_ROOT, loadConfig } from './config.ts';
import { HARMONIZATION as P, fitCalibration, harmonizedDailySql, satellitesSql } from './harmonization.ts';

const args = process.argv.slice(2);
const oos = args.includes('--oos');
const cfg = loadConfig(args.filter((a) => a !== '--oos'));
const fwd = (p: string) => p.replaceAll('\\', '/');
const lit = (s: string) => `'${fwd(s).replaceAll("'", "''")}'`;
const scope = cfg.countries === '*' ? 'world' : cfg.countries.join('-');
const where = cfg.countries === '*' ? 'true' : `country IN (${cfg.countries.map((c) => `'${c.replaceAll("'", "''")}'`).join(', ')})`;

const KNOWN_SATS = ['Terra', 'Aqua', 'S-NPP', 'NOAA-20', 'NOAA-21'];
const BBOX = {
  greece: { lat: [34.8, 41.8], lon: [19.6, 28.3] },
  europe: { lat: [34, 72], lon: [-25, 45] },
};

type Status = 'PASS' | 'WARN' | 'FAIL' | 'INFO';
const results: { section: string; check: string; status: Status; value: string; detail?: unknown }[] = [];
function report(section: string, check: string, status: Status, value: string, detail?: unknown) {
  results.push({ section, check, status, value, detail });
  console.log(`  ${status.padEnd(4)}  ${check}: ${value}`);
}

const tmpDir = path.join(cfg.outputDir, '.staging_validate');
await mkdir(tmpDir, { recursive: true });
const newConn = async () => {
  const c = await (await DuckDBInstance.create(':memory:', { temp_directory: fwd(path.join(tmpDir, 'duckdb_tmp')) })).connect();
  await c.run(`CREATE VIEW hotspots AS SELECT * FROM read_parquet(${lit(path.join(cfg.outputDir, 'hotspots', '**', '*.parquet'))}, hive_partitioning = true) WHERE ${where}`);
  await c.run(`CREATE VIEW harmonized AS SELECT * FROM read_parquet(${lit(path.join(cfg.outputDir, 'harmonized', '**', '*.parquet'))}, hive_partitioning = true) WHERE ${where}`);
  await c.run(`CREATE VIEW harmonized_monthly AS SELECT * FROM read_parquet(${lit(path.join(cfg.outputDir, 'harmonized_monthly', '**', '*.parquet'))}, hive_partitioning = true) WHERE ${where}`);
  return c;
};
const conn = await newConn();
const q = async (sql: string, c: DuckDBConnection = conn) => (await c.runAndReadAll(sql)).getRowObjectsJson() as Record<string, any>[];
const num = (v: unknown) => (v == null ? NaN : Number(v));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const lnErr = (rows: Record<string, any>[], a: string, b: string) => {
  const ok = rows.filter((r) => num(r[a]) > 0 && num(r[b]) > 0);
  return ok.length ? ok.reduce((s, r) => s + Math.abs(Math.log(num(r[b]) / num(r[a]))), 0) / ok.length : NaN;
};
const t0 = performance.now();
console.log(`ETL validation: ${scope} (${cfg.outputDir})\n`);

// ---------------------------------------------------------------- A. data quality
console.log('A. Data quality (normalized hotspots)');
const [dq] = await q(`
  SELECT count(*) AS n,
         count(*) FILTER (WHERE satellite NOT IN (${KNOWN_SATS.map((s) => `'${s}'`).join(',')})) AS bad_sat,
         count(*) FILTER (WHERE confidence IS NULL) AS no_conf,
         count(*) FILTER (WHERE year <> year(acq_date)) AS year_mismatch,
         count(*) FILTER (WHERE latitude NOT BETWEEN -90 AND 90 OR longitude NOT BETWEEN -180 AND 180) AS bad_coord,
         count(*) FILTER (WHERE type = 0) AS veg
  FROM hotspots`);
const n = num(dq.n);
report('quality', 'rows', 'INFO', n.toLocaleString('en'));
report('quality', 'unknown satellite codes', num(dq.bad_sat) ? 'FAIL' : 'PASS', String(dq.bad_sat),
  num(dq.bad_sat) ? await q(`SELECT satellite, count(*) AS n FROM hotspots WHERE satellite NOT IN (${KNOWN_SATS.map((s) => `'${s}'`).join(',')}) GROUP BY 1`) : undefined);
report('quality', 'missing confidence class', num(dq.no_conf) / n > 0.001 ? 'WARN' : 'PASS', `${dq.no_conf} (${pct(num(dq.no_conf) / n)})`);
report('quality', 'file year != acq_date year', num(dq.year_mismatch) / n > 0.001 ? 'WARN' : 'PASS', `${dq.year_mismatch} (${pct(num(dq.year_mismatch) / n)})`);
report('quality', 'coordinates out of range', num(dq.bad_coord) ? 'FAIL' : 'PASS', String(dq.bad_coord));
report('quality', 'vegetation fires (type 0)', 'INFO', pct(num(dq.veg) / n));

const versions = await q(`
  SELECT sensor, version, min(year)::INT AS first_year, max(year)::INT AS last_year, count(*) AS n
  FROM hotspots GROUP BY ALL ORDER BY sensor, first_year`);
report('quality', 'product versions (NRT vs standard mix)', versions.length > 2 ? 'INFO' : 'PASS',
  versions.map((v) => `${v.sensor} ${v.version}: ${v.first_year}-${v.last_year}`).join('; '), versions);

const [{ max_year: maxYear }] = await q(`SELECT max(year)::INT AS max_year FROM hotspots`);
const gaps = await q(`
  WITH c AS (SELECT country, min(year)::INT AS first_year, max(year)::INT AS last_year, count(DISTINCT year) AS years, count(*) AS n
             FROM hotspots WHERE sensor = 'MODIS' GROUP BY 1)
  SELECT * FROM c WHERE n >= 1000 AND (first_year > 2001 OR last_year < ${maxYear} OR years < last_year - first_year + 1)
  ORDER BY n DESC LIMIT 30`);
report('quality', 'countries with coverage gaps (renamed?)', gaps.length ? 'WARN' : 'PASS',
  gaps.length ? gaps.map((g) => `${g.country} ${g.first_year}-${g.last_year}`).join(', ') : 'none', gaps);

// ---------------------------------------------------------------- B. harmonization
console.log('\nB. Harmonization');
const yearly = await q(`
  SELECT year::INT AS y, sum(h) AS h, sum(h_modis) AS hm, sum(h_viirs) AS hv, sum(n_modis + n_viirs) AS raw
  FROM harmonized GROUP BY 1 ORDER BY 1`);
const overlap = yearly.filter((r) => num(r.hm) > 0 && num(r.hv) > 0);
const agree = lnErr(overlap, 'hm', 'hv');
report('harmonization', `MODIS vs VIIRS agreement, yearly (${overlap.length} overlap years)`, agree < 0.1 ? 'PASS' : agree < 0.2 ? 'WARN' : 'FAIL', `mean |ln| = ${agree.toFixed(3)}`,
  overlap.map((r) => ({ year: r.y, h_modis: Math.round(num(r.hm)), h_viirs: Math.round(num(r.hv)), ratio: +(num(r.hv) / num(r.hm)).toFixed(3) })));

// Step test: the combined series must follow the sensor-stable MODIS-only series (no jump when VIIRS arrives).
const withM = yearly.filter((r) => num(r.hm) > 0 && num(r.h) > 0);
const stepMax = Math.max(...withM.map((r) => Math.abs(Math.log(num(r.h) / num(r.hm)))));
report('harmonization', 'combined vs MODIS-only, worst year', stepMax < 0.1 ? 'PASS' : stepMax < 0.2 ? 'WARN' : 'FAIL', `max |ln| = ${stepMax.toFixed(3)}`);
const rawJump = (y: number) => {
  const a = yearly.find((r) => r.y === y - 1), b = yearly.find((r) => r.y === y);
  return a && b ? { raw: num(b.raw) / num(a.raw), h: num(b.h) / num(a.h), hm: num(b.hm) / num(a.hm) } : null;
};
for (const y of [2012, 2018]) {
  const j = rawJump(y);
  if (j) report('harmonization', `year-over-year change at ${y} (raw / harmonized / MODIS-only)`, Math.abs(Math.log(j.h / j.hm)) < 0.1 ? 'PASS' : 'WARN',
    `${j.raw.toFixed(2)}x / ${j.h.toFixed(2)}x / ${j.hm.toFixed(2)}x`);
}

const perCountry = await q(`
  WITH c AS (SELECT country, sum(h_modis) AS hm, sum(h_viirs) AS hv, sum(h) AS h FROM harmonized
             WHERE h_modis IS NOT NULL AND h_viirs IS NOT NULL GROUP BY 1)
  SELECT country, round(hm) AS hm, round(hv) AS hv, round(ln(hv / hm), 3) AS ln_ratio FROM c
  WHERE hm > 0 AND hv > 0 ORDER BY h DESC LIMIT 30`);
if (perCountry.length > 1) {
  const bad = perCountry.filter((r) => Math.abs(num(r.ln_ratio)) > 0.1);
  report('harmonization', 'per-country agreement, top 30 (overlap total)', bad.length ? 'WARN' : 'PASS',
    bad.length ? `${bad.length} countries off by >10%: ${bad.map((r) => `${r.country} ${(100 * (Math.exp(num(r.ln_ratio)) - 1)).toFixed(0)}%`).join(', ')}` : 'all within 10%', perCountry);
  const perCountryYear = await q(`
    WITH top AS (SELECT country FROM harmonized GROUP BY 1 ORDER BY sum(h) DESC LIMIT 30),
    cy AS (SELECT country, year, sum(h_modis) AS hm, sum(h_viirs) AS hv FROM harmonized
           WHERE country IN (SELECT country FROM top) AND h_modis IS NOT NULL AND h_viirs IS NOT NULL GROUP BY ALL)
    SELECT avg(abs(ln(hv / hm))) AS err FROM cy WHERE hm >= 50 AND hv >= 50`);
  const e = num(perCountryYear[0].err);
  report('harmonization', 'per-country-year agreement, top 30 countries', e < 0.15 ? 'PASS' : e < 0.25 ? 'WARN' : 'FAIL', `mean |ln| = ${e.toFixed(3)}`);
}

// Satellite stability: same-family ratios year by year (Terra orbit drift, NOAA-20 vs S-NPP).
const drift = await q(`
  WITH cd AS (
    SELECT year::INT AS y, satellite, count(DISTINCT (acq_date, floor(latitude / ${P.fineGridDeg}), floor(longitude / ${P.fineGridDeg}))) AS n
    FROM hotspots WHERE type = 0 AND satellite IN ('Terra', 'Aqua', 'S-NPP', 'NOAA-20') GROUP BY ALL)
  SELECT y, round(max(n) FILTER (WHERE satellite = 'Terra') / max(n) FILTER (WHERE satellite = 'Aqua'), 3) AS terra_aqua,
            round(max(n) FILTER (WHERE satellite = 'NOAA-20') / max(n) FILTER (WHERE satellite = 'S-NPP'), 3) AS n20_snpp
  FROM cd GROUP BY y ORDER BY y`);
const ta = drift.filter((r) => r.terra_aqua != null);
const early = ta.filter((r) => r.y >= 2003 && r.y <= 2015).map((r) => num(r.terra_aqua));
const late = ta.filter((r) => r.y >= 2022).map((r) => num(r.terra_aqua));
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
if (early.length && late.length) {
  const drop = avg(late) / avg(early);
  report('harmonization', 'Terra/Aqua cell-day ratio, 2022+ vs 2003-2015', drop > 0.85 ? 'PASS' : 'WARN',
    `${avg(early).toFixed(2)} -> ${avg(late).toFixed(2)} (${pct(drop - 1)})`, drift);
}

if (oos) {
  // Out-of-sample: fit k on 2012-2018 only, then compare MODIS-only vs VIIRS-only on 2019+ (never seen in the fit).
  console.log('  ...out-of-sample test (fit 2012-2018, test 2019+)');
  const t = performance.now();
  const c2 = await newConn();
  await c2.run(`CREATE TABLE sats AS ${satellitesSql}`);
  await fitCalibration(c2, P, [2012, 2013, 2014, 2015, 2016, 2017, 2018]);
  const test = await q(`
    WITH d AS (${harmonizedDailySql('year >= 2019', P)})
    SELECT year::INT AS y, country, sum(h_modis) AS hm, sum(h_viirs) AS hv FROM d GROUP BY ALL`, c2);
  const byYear = Object.values(test.reduce((m: Record<number, any>, r) => {
    (m[r.y] ??= { y: r.y, hm: 0, hv: 0 }); m[r.y].hm += num(r.hm) || 0; m[r.y].hv += num(r.hv) || 0; return m;
  }, {}));
  const e = lnErr(byYear, 'hm', 'hv');
  report('harmonization', 'OUT-OF-SAMPLE yearly agreement 2019+ (k fitted on 2012-2018)', e < 0.1 ? 'PASS' : e < 0.2 ? 'WARN' : 'FAIL',
    `mean |ln| = ${e.toFixed(3)} (${((performance.now() - t) / 1000).toFixed(0)} s)`, byYear);
  const big = test.filter((r) => num(r.hm) >= 200);
  const eC = lnErr(big, 'hm', 'hv');
  report('harmonization', 'OUT-OF-SAMPLE country-year agreement 2019+', eC < 0.15 ? 'PASS' : eC < 0.25 ? 'WARN' : 'FAIL', `mean |ln| = ${eC.toFixed(3)} over ${big.length} country-years`);
  c2.closeSync();
}

// ---------------------------------------------------------------- C. query speed (what the API will run)
console.log('\nC. Query speed (warm, best of 2)');
const bb = (b: { lat: number[]; lon: number[] }, latCol = 'latitude', lonCol = 'longitude') =>
  `${latCol} BETWEEN ${b.lat[0]} AND ${b.lat[1]} AND ${lonCol} BETWEEN ${b.lon[0]} AND ${b.lon[1]}`;
const csvFile = path.join(tmpDir, 'export.csv');
const timings: Record<string, number> = {};
async function timed(name: string, sql: string, limitMs: number) {
  let best = Infinity;
  let rows = 0;
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    const r = await conn.runAndReadAll(sql);
    best = Math.min(best, performance.now() - t);
    rows = r.currentRowCount;
  }
  timings[name] = Math.round(best);
  report('speed', name, best <= limitMs ? 'PASS' : 'WARN', `${Math.round(best)} ms (${rows} rows, target <= ${limitMs} ms)`);
}
await timed('calendar, whole dataset, year x month', `SELECT year, month, sum(h) AS h FROM harmonized_monthly GROUP BY ALL`, 1000);
await timed('calendar, Greece bbox, year x month', `SELECT year, month, sum(h) AS h FROM harmonized_monthly WHERE ${bb(BBOX.greece, 'lat', 'lon')} GROUP BY ALL`, 1000);
await timed('calendar, Greece bbox, daily', `SELECT acq_date, sum(h) AS h FROM harmonized WHERE ${bb(BBOX.greece, 'lat', 'lon')} GROUP BY ALL`, 1000);
await timed('map grid, Europe bbox, one summer', `SELECT cell_lat, cell_lon, sum(h) AS h FROM harmonized WHERE ${bb(BBOX.europe, 'lat', 'lon')} AND acq_date BETWEEN DATE '2023-06-01' AND DATE '2023-09-30' GROUP BY ALL`, 1000);
{
  const t = performance.now();
  await conn.run(`COPY (SELECT latitude, longitude, acq_datetime, satellite, confidence, frp FROM hotspots
    WHERE type = 0 AND ${bb(BBOX.greece)} AND year BETWEEN 2021 AND 2023) TO ${lit(csvFile)} (HEADER)`);
  const ms = performance.now() - t;
  timings['csv export, Greece bbox, 2021-2023'] = Math.round(ms);
  report('speed', 'csv export, Greece bbox, 2021-2023', ms <= 3000 ? 'PASS' : 'WARN', `${Math.round(ms)} ms (target <= 3000 ms)`);
}

await rm(tmpDir, { recursive: true, force: true });
const out = path.join(REPO_ROOT, 'data', 'reports', `validate-${scope}.json`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ scope, at: new Date().toISOString(), params: P, results }, null, 2));
const count = (s: Status) => results.filter((r) => r.status === s).length;
console.log(`\n${count('PASS')} PASS, ${count('WARN')} WARN, ${count('FAIL')} FAIL in ${((performance.now() - t0) / 1000).toFixed(0)} s -> ${out}`);
conn.closeSync();
if (count('FAIL')) process.exitCode = 1;
