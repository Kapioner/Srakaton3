// Discovers raw FIRMS country CSVs and parses their names.
// File name pattern: <source>_<year>_<Country>.csv, e.g. viirs-jpss1_2025_Greece.csv.
// Works for both layouts: sample_data/<source>/*.csv and data/<source>/<year>/*.csv.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { EtlConfig } from './config.ts';

export const SOURCES = ['modis', 'viirs-snpp', 'viirs-jpss1', 'viirs-jpss2'] as const;
export type Source = (typeof SOURCES)[number];

export interface RawFile {
  path: string; // absolute, forward slashes (DuckDB-friendly)
  source: Source;
  year: number;
  country: string;
}

const FILE_RE = new RegExp(`^(${SOURCES.join('|')})_(\\d{4})_(.+)\\.csv$`);

export function parseFileName(file: string): Omit<RawFile, 'path'> | null {
  const m = path.basename(file).match(FILE_RE);
  if (!m) return null;
  return { source: m[1] as Source, year: Number(m[2]), country: m[3] };
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function discoverFiles(cfg: EtlConfig): Promise<RawFile[]> {
  const files: RawFile[] = [];
  for await (const file of walk(cfg.inputDir)) {
    const meta = parseFileName(file);
    if (!meta) continue;
    if (cfg.years !== '*' && !cfg.years.has(meta.year)) continue;
    if (cfg.countries !== '*' && !cfg.countries.includes(meta.country)) continue;
    files.push({ ...meta, path: file.replaceAll('\\', '/') });
  }
  files.sort((a, b) => a.year - b.year || a.country.localeCompare(b.country) || a.source.localeCompare(b.source));
  return files;
}

export function groupByYear(files: RawFile[]): Map<number, RawFile[]> {
  const byYear = new Map<number, RawFile[]>();
  for (const f of files) {
    if (!byYear.has(f.year)) byYear.set(f.year, []);
    byYear.get(f.year)!.push(f);
  }
  return byYear;
}
