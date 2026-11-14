// ETL step 1: raw FIRMS CSVs -> normalized, hive-partitioned Parquet.
//
//   npm run etl:normalize                                   # Greece from sample_data/ (dev)
//   npm run etl:normalize -- --countries '*' --years 2025 --input data
//   npm run etl:normalize -- --force                        # rebuild existing partitions
//
// Output: <OUTPUT_DIR>/hotspots/year=YYYY/country=Name/part_0.parquet
// Incremental: a (year, country) partition that already exists is skipped unless --force.
// Each year is written to a staging folder first and swapped in, so a crash never leaves half a partition.

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig } from './config.ts';
import { discoverFiles, groupByYear, type RawFile } from './sources.ts';
import { copyToParquet, lit, rawCountSelect } from './sql.ts';

const cfg = loadConfig();
const hotspotsDir = path.join(cfg.outputDir, 'hotspots');
const stagingRoot = path.join(cfg.outputDir, '.staging');
const runLog = path.join(cfg.outputDir, 'etl_runs.jsonl');

const exists = (p: string) => stat(p).then(() => true, () => false);
const partitionDir = (year: number, country: string) => path.join(hotspotsDir, `year=${year}`, `country=${country}`);
const fwd = (p: string) => p.replaceAll('\\', '/');

const t0 = performance.now();
const files = await discoverFiles(cfg);
if (!files.length) {
  console.error(`No FIRMS CSVs matched in ${cfg.inputDir} (countries=${cfg.countries}, years=${cfg.years === '*' ? '*' : [...cfg.years].join(',')})`);
  process.exit(1);
}

await mkdir(hotspotsDir, { recursive: true });
await mkdir(stagingRoot, { recursive: true });
const instance = await DuckDBInstance.create(':memory:', {
  temp_directory: fwd(path.join(stagingRoot, 'duckdb_tmp')),
  preserve_insertion_order: 'false',
  ...(cfg.threads ? { threads: String(cfg.threads) } : {}),
});
const conn = await instance.connect();
const scalar = async (sql: string) => Number((await (await conn.runAndReadAll(sql)).getRowObjectsJson())[0].n);

console.log(`ETL normalize: ${files.length} files from ${path.relative(process.cwd(), cfg.inputDir) || '.'} -> ${hotspotsDir}`);

let totalIn = 0;
let totalOut = 0;
for (const [year, yearFiles] of groupByYear(files)) {
  // Incremental: only countries whose partition is missing (or everything with --force).
  const todo: RawFile[] = [];
  for (const f of yearFiles) {
    if (cfg.force || !(await exists(partitionDir(year, f.country)))) todo.push(f);
  }
  if (!todo.length) {
    console.log(`${year}  skipped (all ${new Set(yearFiles.map((f) => f.country)).size} partitions exist)`);
    continue;
  }

  const tYear = performance.now();
  const staging = path.join(stagingRoot, `year_${year}`);
  await rm(staging, { recursive: true, force: true });

  const rowsIn = await scalar(rawCountSelect(todo));
  await conn.run(copyToParquet(todo, staging));
  const stagedGlob = fwd(path.join(staging, '**', '*.parquet'));
  const rowsOut = rowsIn ? await scalar(`SELECT count(*) AS n FROM read_parquet(${lit(stagedGlob)})`) : 0;
  if (rowsIn !== rowsOut) throw new Error(`${year}: row count mismatch (csv ${rowsIn} vs parquet ${rowsOut})`);

  // Swap staged partitions into place.
  const countries = [...new Set(todo.map((f) => f.country))];
  for (const country of countries) {
    const target = partitionDir(year, country);
    await rm(target, { recursive: true, force: true });
    const staged = path.join(staging, `year=${year}`, `country=${country}`);
    if (await exists(staged)) {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(staged, target);
    }
  }
  await rm(staging, { recursive: true, force: true });

  const seconds = (performance.now() - tYear) / 1000;
  const sources = [...new Set(todo.map((f) => f.source))].join(',');
  console.log(
    `${year}  ${String(rowsOut).padStart(10)} rows  ${String(countries.length).padStart(3)} countries  ` +
      `${String(todo.length).padStart(4)} files  ${seconds.toFixed(1).padStart(6)} s  [${sources}]`,
  );
  totalIn += rowsIn;
  totalOut += rowsOut;
  await appendFile(
    runLog,
    JSON.stringify({ at: new Date().toISOString(), step: 'normalize', year, countries: countries.length, files: todo.length, rows: rowsOut, seconds: +seconds.toFixed(2) }) + '\n',
  );
}

await rm(stagingRoot, { recursive: true, force: true });
const total = (performance.now() - t0) / 1000;
console.log(`\nDone: ${totalOut} rows written (${totalIn} read) in ${total.toFixed(1)} s.`);

// Quick summary of the whole dataset on disk.
const all = fwd(path.join(hotspotsDir, '**', '*.parquet'));
const summary = await conn.runAndReadAll(`
  SELECT sensor, satellite, min(acq_date)::VARCHAR AS first, max(acq_date)::VARCHAR AS last,
         count(*) AS rows, count(*) FILTER (WHERE type = 0) AS vegetation_fire
  FROM read_parquet(${lit(all)}, hive_partitioning = true)
  GROUP BY ALL ORDER BY first`);
console.table(summary.getRowObjectsJson());
conn.closeSync();
