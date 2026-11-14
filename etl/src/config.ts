// ETL configuration: data scope is config, not code.
// Sources (later wins): defaults < env vars < CLI flags.
//
//   DATA_COUNTRIES  Greece | Greece,Poland | *            (--countries)
//   DATA_YEARS      2000-2025 | 2021 | 2012,2021 | *      (--years)
//   INPUT_DIR       folder scanned recursively for FIRMS CSVs (--input)
//   OUTPUT_DIR      root of the harmonized Parquet dataset   (--output)
//   --force         rebuild partitions that already exist
//
// Relative paths resolve against the repository root. Env vars may also come from <repo>/.env
// (shared with the API server, so both use the same OUTPUT_DIR).

import { existsSync } from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export interface EtlConfig {
  countries: '*' | string[];
  years: '*' | Set<number>;
  inputDir: string;
  outputDir: string;
  force: boolean;
  threads: number | null;
}

function parseYears(spec: string): '*' | Set<number> {
  if (spec.trim() === '*') return '*';
  const years = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (range) {
      for (let y = Number(range[1]); y <= Number(range[2]); y++) years.add(y);
    } else if (/^\d{4}$/.test(part)) {
      years.add(Number(part));
    } else {
      throw new Error(`Invalid year spec "${part}" (use e.g. 2000-2025, 2021 or *)`);
    }
  }
  return years;
}

function parseCountries(spec: string): '*' | string[] {
  if (spec.trim() === '*') return '*';
  // FIRMS file names use underscores instead of spaces (e.g. Bosnia_and_Herzegovina).
  return spec.split(',').map((s) => s.trim().replace(/\s+/g, '_')).filter(Boolean);
}

export function loadConfig(argv = process.argv.slice(2)): EtlConfig {
  const raw = {
    countries: process.env.DATA_COUNTRIES ?? 'Greece',
    years: process.env.DATA_YEARS ?? '*',
    input: process.env.INPUT_DIR ?? 'sample_data',
    output: process.env.OUTPUT_DIR ?? 'data/parquet',
    threads: process.env.DUCKDB_THREADS ?? '',
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--countries': raw.countries = next(); break;
      case '--years': raw.years = next(); break;
      case '--input': raw.input = next(); break;
      case '--output': raw.output = next(); break;
      case '--threads': raw.threads = next(); break;
      case '--force': raw.force = true; break;
      case '-h':
      case '--help':
        console.log('Usage: npm run etl:normalize -- [--countries Greece|*] [--years 2000-2025|*] [--input dir] [--output dir] [--threads n] [--force]');
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    countries: parseCountries(raw.countries),
    years: parseYears(raw.years),
    inputDir: path.resolve(REPO_ROOT, raw.input),
    outputDir: path.resolve(REPO_ROOT, raw.output),
    force: raw.force,
    threads: raw.threads ? Number(raw.threads) : null,
  };
}
