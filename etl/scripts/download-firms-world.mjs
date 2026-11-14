#!/usr/bin/env node
// Downloads NASA FIRMS yearly "all countries" archives (one ZIP per sensor and year) and extracts them
// into the layout the ETL expects: <out>/<sensor>/<year>/<sensor>_<year>_<Country>.csv
// Source: https://firms.modaps.eosdis.nasa.gov/data/country/zips/<sensor>_<year>_all_countries.zip
//
// ~50 large files instead of ~11 000 per-country CSVs, downloaded ONE AT A TIME with a pause between them,
// retries with back-off on errors / HTTP 429 / 5xx (honouring Retry-After), so the server is not hammered.
//
// Usage (from repo root):
//   npm run etl:download-world -- --dry-run                 # list what would be downloaded + total size, no download
//   npm run etl:download-world                              # all sensors, 2000..current year -> data/
//   npm run etl:download-world -- --from 2018 --to 2020 --sensors viirs-snpp,viirs-jpss1
//   npm run etl:download-world -- --refresh                 # re-download years whose archive changed on the server
//   npm run etl:download-world -- --force --from 2025 --to 2025
//
// A finished year gets a marker file <out>/<sensor>/<year>/.complete.json (URL, size, Last-Modified).
// Existing year folders are skipped, so an interrupted run can simply be started again.
// After re-downloading a year that was already processed, run the ETL with --force for that year.

import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const BASE_URL = 'https://firms.modaps.eosdis.nasa.gov/data/country/zips';
const ALL_SENSORS = ['modis', 'viirs-snpp', 'viirs-jpss1', 'viirs-jpss2'];
const FIRST_YEAR = { modis: 2000, 'viirs-snpp': 2012, 'viirs-jpss1': 2018, 'viirs-jpss2': 2024 };
const USER_AGENT = 'firms-archive-downloader/1.0 (research use; sequential)';
const RETRIES = 4;
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function parseArgs(argv) {
  const opts = { sensors: ALL_SENSORS, from: 2000, to: new Date().getFullYear(), out: 'data', pause: 5, force: false, refresh: false, dryRun: false, keepZips: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--sensors': opts.sensors = next().split(',').map((s) => s.trim()); break;
      case '--from': opts.from = Number(next()); break;
      case '--to': opts.to = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '--pause': opts.pause = Number(next()); break;
      case '--force': opts.force = true; break;
      case '--refresh': opts.refresh = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--keep-zips': opts.keepZips = true; break;
      case '-h':
      case '--help':
        console.log('Options: --sensors a,b --from <year> --to <year> --out <dir> --pause <seconds> --force --refresh --dry-run --keep-zips');
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  for (const s of opts.sensors) if (!ALL_SENSORS.includes(s)) throw new Error(`Unknown sensor ${s} (use ${ALL_SENSORS.join(', ')})`);
  opts.out = path.resolve(REPO_ROOT, opts.out);
  return opts;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const exists = (p) => access(p).then(() => true, () => false);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** fetch with retries + back-off; 404 is returned as-is (archive not available). */
async function politeFetch(url, method = 'GET') {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      if (attempt > RETRIES) throw err;
      const wait = 30 * 2 ** (attempt - 1);
      console.log(`   network error (${err.message}), retry in ${wait} s`);
      await sleep(wait);
      continue;
    }
    if (res.ok || res.status === 404) return res;
    if (attempt > RETRIES || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status} for ${url}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30 * 2 ** (attempt - 1);
    console.log(`   HTTP ${res.status}, server asks to slow down - waiting ${wait} s`);
    await res.body?.cancel();
    await sleep(wait);
  }
}

async function download(url, target, size) {
  const res = await politeFetch(url);
  if (res.status === 404) return false;
  const part = `${target}.part`;
  let done = 0;
  let lastPct = -10;
  const counter = new TransformStream({
    transform(chunk, ctrl) {
      done += chunk.byteLength;
      const pct = size ? Math.floor((100 * done) / size) : 0;
      if (size && pct >= lastPct + 10) {
        lastPct = pct - (pct % 10);
        process.stdout.write(` ${lastPct}%`);
      }
      ctrl.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part));
  process.stdout.write('\n');
  if (size && done !== size) throw new Error(`Incomplete download (${done} of ${size} bytes)`);
  await rename(part, target);
  return true;
}

/**
 * Extracts only <sensor>/<year>/<file> entries (no path traversal) straight into the year folder.
 * A `.incomplete` flag marks an unfinished extraction (folder renames are unreliable on Windows while
 * antivirus scans fresh files), so an interrupted year is redone on the next run.
 */
async function extract(zipFile, sensor, year, outDir) {
  const tmpDir = path.join(outDir, sensor, String(year));
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  await writeFile(path.join(tmpDir, '.incomplete'), '');
  const allowed = new RegExp(`^${sensor}/${year}/([^/\\\\]+)$`);
  let files = 0;
  const zip = await new Promise((resolve, reject) => yauzl.open(zipFile, { lazyEntries: true }, (e, z) => (e ? reject(e) : resolve(z))));
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      const m = entry.fileName.match(allowed);
      if (!m || m[1].startsWith('.')) return zip.readEntry(); // folders, unexpected paths
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        pipeline(stream, createWriteStream(path.join(tmpDir, m[1])))
          .then(() => { files++; zip.readEntry(); })
          .catch(reject);
      });
    });
    zip.readEntry();
  });
  zip.close();
  if (!files) throw new Error(`No ${sensor}/${year}/ files found in ${zipFile}`);
  return files;
}

async function readMarker(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, '.complete.json'), 'utf8'));
  } catch {
    return null;
  }
}

const opts = parseArgs(process.argv.slice(2));
const jobs = [];
for (const sensor of opts.sensors) {
  for (let year = Math.max(opts.from, FIRST_YEAR[sensor]); year <= opts.to; year++) jobs.push({ sensor, year });
}

console.log(`FIRMS world download: ${opts.sensors.join(', ')}, ${opts.from}-${opts.to} -> ${opts.out}${opts.dryRun ? ' (dry run)' : ''}`);
const zipDir = path.join(opts.out, '_zips');
await mkdir(zipDir, { recursive: true });
const summary = { downloaded: 0, skipped: 0, missing: 0, bytes: 0, planned: 0 };

for (const [i, { sensor, year }] of jobs.entries()) {
  const label = `[${i + 1}/${jobs.length}] ${sensor} ${year}`.padEnd(28);
  const name = `${sensor}_${year}_all_countries.zip`;
  const url = `${BASE_URL}/${name}`;
  const yearDir = path.join(opts.out, sensor, String(year));
  const marker = await readMarker(yearDir);
  const hasCsv = (await exists(yearDir)) && !(await exists(path.join(yearDir, '.incomplete'))) && (await readdir(yearDir)).some((f) => f.endsWith('.csv'));

  if (!opts.force && !opts.refresh && hasCsv) {
    console.log(`${label} skipped (${marker ? 'complete' : 'folder exists, no marker - use --force to replace'})`);
    summary.skipped++;
    continue;
  }

  const head = await politeFetch(url, 'HEAD');
  if (head.status === 404) {
    console.log(`${label} not available on the server`);
    summary.missing++;
    continue;
  }
  const size = Number(head.headers.get('content-length')) || 0;
  const lastModified = head.headers.get('last-modified');
  if (opts.refresh && !opts.force && hasCsv && marker && marker.lastModified === lastModified) {
    console.log(`${label} up to date`);
    summary.skipped++;
    continue;
  }
  if (opts.dryRun) {
    console.log(`${label} would download ${mb(size)} (last modified ${lastModified})`);
    summary.planned += size;
    await sleep(1);
    continue;
  }

  const zipFile = path.join(zipDir, name);
  const zipOk = (await exists(zipFile)) && (await stat(zipFile)).size === size;
  if (!zipOk) {
    process.stdout.write(`${label} downloading ${mb(size)}:`);
    await download(url, zipFile, size);
    summary.bytes += size;
  } else {
    console.log(`${label} using already downloaded ${name}`);
  }
  const files = await extract(zipFile, sensor, year, opts.out);
  await writeFile(path.join(yearDir, '.complete.json'), JSON.stringify({ url, size, lastModified, files, at: new Date().toISOString() }, null, 2));
  await rm(path.join(yearDir, '.incomplete'), { force: true });
  if (!opts.keepZips) await rm(zipFile, { force: true });
  console.log(`${' '.repeat(28)} extracted ${files} files -> ${path.relative(REPO_ROOT, yearDir)}`);
  summary.downloaded++;
  if (i < jobs.length - 1) await sleep(opts.pause);
}

if (!opts.keepZips && (await readdir(zipDir)).length === 0) await rm(zipDir, { recursive: true, force: true });
console.log(
  opts.dryRun
    ? `\nDry run: ${jobs.length - summary.skipped - summary.missing} archives, ${mb(summary.planned)} to download; ${summary.skipped} already present, ${summary.missing} not available.`
    : `\nDone: ${summary.downloaded} downloaded (${mb(summary.bytes)}), ${summary.skipped} skipped, ${summary.missing} not available.`,
);
