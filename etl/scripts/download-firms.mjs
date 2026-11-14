#!/usr/bin/env node
// Downloads NASA FIRMS yearly per-country active-fire CSVs.
// Source: https://firms.modaps.eosdis.nasa.gov/data/country/<sensor>/<year>/<sensor>_<year>_<Country>.csv
//
// Usage (from repo root):
//   node etl/scripts/download-firms.mjs                       # Greece, all sensors, 2000..current year
//   node etl/scripts/download-firms.mjs --country Poland
//   node etl/scripts/download-firms.mjs --from 2010 --to 2015 --sensors modis,viirs-snpp
//   node etl/scripts/download-firms.mjs --out sample_data --force
//
// Files that already exist are skipped unless --force is given.
// Missing sensor/year combinations (HTTP 404) are reported and skipped.

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/data/country';
const ALL_SENSORS = ['modis', 'viirs-snpp', 'viirs-jpss1', 'viirs-jpss2'];
const CONCURRENCY = 4;
const RETRIES = 3;

function parseArgs(argv) {
  const opts = {
    country: 'Greece',
    sensors: ALL_SENSORS,
    from: 2000,
    to: new Date().getFullYear(),
    out: 'sample_data',
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--country': opts.country = next(); break;
      case '--sensors': opts.sensors = next().split(',').map((s) => s.trim()); break;
      case '--from': opts.from = Number(next()); break;
      case '--to': opts.to = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '--force': opts.force = true; break;
      case '-h':
      case '--help':
        console.log('Options: --country <Name> --sensors a,b --from <year> --to <year> --out <dir> --force');
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  return opts;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function download(job, opts) {
  const { sensor, year } = job;
  const fileName = `${sensor}_${year}_${opts.country}.csv`;
  const url = `${BASE_URL}/${sensor}/${year}/${encodeURIComponent(fileName)}`;
  const dir = path.join(opts.out, sensor);
  const target = path.join(dir, fileName);

  if (!opts.force && (await exists(target))) return { ...job, status: 'skipped' };

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return { ...job, status: 'missing' };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      await mkdir(dir, { recursive: true });
      await writeFile(target, body);
      return { ...job, status: 'downloaded', bytes: body.length };
    } catch (err) {
      if (attempt === RETRIES) return { ...job, status: 'error', error: err.message };
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function runPool(jobs, worker, limit) {
  const results = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await worker(job);
      results.push(result);
      const label = `${result.sensor} ${result.year}`.padEnd(18);
      const extra = result.bytes ? ` (${(result.bytes / 1024).toFixed(0)} KB)` : result.error ? ` (${result.error})` : '';
      console.log(`${label} ${result.status}${extra}`);
    }
  });
  await Promise.all(runners);
  return results;
}

const opts = parseArgs(process.argv.slice(2));
const jobs = [];
for (const sensor of opts.sensors) {
  for (let year = opts.from; year <= opts.to; year++) jobs.push({ sensor, year });
}

console.log(`FIRMS download: ${opts.country}, ${opts.from}-${opts.to}, sensors: ${opts.sensors.join(', ')} -> ${opts.out}/`);
const results = await runPool(jobs, (job) => download(job, opts), CONCURRENCY);

const count = (s) => results.filter((r) => r.status === s).length;
const totalKb = results.reduce((sum, r) => sum + (r.bytes ?? 0), 0) / 1024;
console.log(
  `\nDone: ${count('downloaded')} downloaded (${(totalKb / 1024).toFixed(1)} MB), ` +
    `${count('skipped')} already present, ${count('missing')} not available, ${count('error')} errors.`,
);
if (count('error') > 0) process.exitCode = 1;
