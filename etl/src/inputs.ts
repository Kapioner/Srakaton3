import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../shared/config.ts';

export const SENSORS = ['modis', 'viirs-snpp', 'viirs-jpss1'] as const;
export type Sensor = (typeof SENSORS)[number];

export interface InputFile {
  path: string;
  sensor: Sensor;
  year: number;
  country: string;
}

// <sensor>_<year>_<Country>.csv, e.g. viirs-jpss1_2025_Greece.csv
const FILE_RE = /^(modis|viirs-snpp|viirs-jpss1)_(\d{4})_(.+)\.csv$/;

/** Lists raw CSVs under <dataDir>/<sensor>/ that match the configured countries and years. */
export async function findInputFiles(config: Config): Promise<InputFile[]> {
  const [fromYear, toYear] = config.years;
  const files: InputFile[] = [];
  for (const sensor of SENSORS) {
    const dir = path.join(config.dataDir, sensor);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match) continue;
      const year = Number(match[2]);
      const country = match[3];
      if (year < fromYear || year > toYear) continue;
      if (config.countries && !config.countries.includes(country)) continue;
      files.push({ path: path.join(dir, name), sensor, year, country });
    }
  }
  return files.sort((a, b) => a.sensor.localeCompare(b.sensor) || a.year - b.year || a.country.localeCompare(b.country));
}
