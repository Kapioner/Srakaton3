// ETL entry point: raw FIRMS CSVs -> harmonized Parquet + calibration (see docs/PLAN.md, section 3).
//
// Stage 0 (this file): resolve the configuration, list the input files and prove DuckDB can read them.
// Stage 1 adds: load.ts (common schema), grid.ts (daily_cells). Stage 2 adds: calibrate.ts.
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from '../../shared/config.ts';
import { findInputFiles, SENSORS } from './inputs.ts';

const files = await findInputFiles(config);
if (files.length === 0) {
  console.error(`No input files in ${config.dataDir} for the configured countries and years.`);
  console.error('Download some with: npm run download');
  process.exit(1);
}

console.log(`Data dir:   ${config.dataDir}`);
console.log(`Countries:  ${config.countries?.join(', ') ?? 'all'}`);
console.log(`Years:      ${config.years[0]}-${config.years[1]}`);
console.log(`Output dir: ${config.processedDir}`);
console.log(`Grid:       ${config.gridResDeg} deg\n`);

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();

for (const sensor of SENSORS) {
  const sensorFiles = files.filter((f) => f.sensor === sensor);
  if (sensorFiles.length === 0) continue;
  const list = sensorFiles.map((f) => `'${f.path.replaceAll('\\', '/')}'`).join(', ');
  const reader = await connection.runAndReadAll(
    `SELECT count(*) AS n, min(acq_date)::VARCHAR AS first, max(acq_date)::VARCHAR AS last FROM read_csv([${list}])`,
  );
  const [row] = reader.getRowObjectsJson() as { n: string; first: string; last: string }[];
  console.log(`${sensor.padEnd(12)} ${String(sensorFiles.length).padStart(3)} files  ${String(row.n).padStart(9)} rows  ${row.first} .. ${row.last}`);
}

connection.closeSync();
console.log('\nInputs are readable. The harmonization pipeline is the next step (stage 1).');
