// ETL report: one self-contained HTML page with the "before / after" charts, generated from the Parquet dataset.
//
//   npm run etl:report                                      # countries from config (dev: Greece)
//   npm run etl:report -- --output data/parquet_global --countries '*'
//
// Writes data/reports/etl-report-<scope>.html (open in a browser; ECharts is loaded from a CDN).

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { REPO_ROOT, loadConfig } from './config.ts';
import { HARMONIZATION } from './harmonization.ts';

const cfg = loadConfig();
const fwd = (p: string) => p.replaceAll('\\', '/');
const lit = (s: string) => `'${fwd(s).replaceAll("'", "''")}'`;
const exists = (p: string) => stat(p).then(() => true, () => false);

const hotspots = path.join(cfg.outputDir, 'hotspots', '**', '*.parquet');
const harmonized = path.join(cfg.outputDir, 'harmonized', '**', '*.parquet');
const kFile = path.join(cfg.outputDir, 'calibration', 'k.parquet');
for (const [p, step] of [[kFile, 'etl:harmonize'], [path.join(cfg.outputDir, 'hotspots'), 'etl:normalize']]) {
  if (!(await exists(p))) throw new Error(`Missing ${p} - run npm run ${step} first`);
}

const scope = cfg.countries === '*' ? 'world' : cfg.countries.join('-');
const where = cfg.countries === '*' ? 'true' : `country IN (${cfg.countries.map((c) => `'${c.replaceAll("'", "''")}'`).join(', ')})`;

const conn = await (await DuckDBInstance.create(':memory:')).connect();
const q = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, any>[];
await conn.run(`CREATE VIEW hs AS SELECT * FROM read_parquet(${lit(hotspots)}, hive_partitioning = true) WHERE ${where}`);
await conn.run(`CREATE VIEW hz AS SELECT * FROM read_parquet(${lit(harmonized)}, hive_partitioning = true) WHERE ${where}`);

const data = {
  scope: scope.replaceAll('_', ' '),
  params: HARMONIZATION,
  rawBySat: await q(`SELECT year::INT AS y, satellite AS s, count(*)::INT AS n FROM hs GROUP BY ALL ORDER BY ALL`),
  byType: await q(`SELECT year::INT AS y, type::INT AS t, count(*)::INT AS n FROM hs GROUP BY ALL ORDER BY ALL`),
  yearly: await q(`
    SELECT year::INT AS y, sum(n_modis + n_viirs)::INT AS raw, round(sum(h), 1) AS h,
           round(sum(h_modis), 1) AS hm, round(sum(h_viirs), 1) AS hv
    FROM hz GROUP BY ALL ORDER BY y`),
  monthly: await q(`
    SELECT year::INT AS y, month(acq_date)::INT AS m, round(sum(h), 1) AS h, round(sum(h_modis), 1) AS hm, round(sum(h_viirs), 1) AS hv
    FROM hz GROUP BY ALL ORDER BY ALL`),
  k: await q(`
    SELECT satellite AS s, cls::INT AS c,
           round(${cfg.countries !== '*' && cfg.countries.length === 1 ? 'any_value(k)' : 'any_value(k_global)'}, 2) AS k
    FROM read_parquet(${lit(kFile)}) WHERE ${where} GROUP BY ALL ORDER BY ALL`),
  sats: await q(`SELECT satellite AS s, sensor, min(acq_date)::VARCHAR AS first, max(acq_date)::VARCHAR AS last, count(*)::INT AS n FROM hs GROUP BY ALL ORDER BY first`),
};
conn.closeSync();

const template = await readFile(path.join(import.meta.dirname, 'report.template.html'), 'utf8');
const html = template
  .replaceAll('__SCOPE__', data.scope)
  .replace('__DATA__', JSON.stringify(data).replaceAll('<', '\\u003c'));
const outFile = path.join(REPO_ROOT, 'data', 'reports', `etl-report-${scope}.html`);
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, html);
console.log(`Report written: ${outFile}`);
console.log(`Open in a browser: file:///${fwd(outFile)}`);
