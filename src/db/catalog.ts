import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './database.js';
import { HOTSPOT_COLUMNS, HOTSPOT_COLUMN_NAMES } from './schema.js';

export interface ArchiveInfo {
  archiveDir: string;
  available: boolean;
  partitions: number;
  /** Last day the archive holds, per satellite. Live rows up to that day are hidden (archive wins). */
  coverage: { satellite: string; lastDate: string }[];
  refreshedAt: string | null;
}

const fwd = (p: string) => p.replaceAll('\\', '/');
const lit = (s: string) => `'${fwd(s).replaceAll("'", "''")}'`;

/**
 * Exposes archive (ETL Parquet) and live hotspots as one read-only view, `hotspots_all`,
 * with the ETL's columns plus `ingested_at` (live only) and `origin` ('archive' | 'live').
 *
 * Overlap rule: for every satellite, days the archive already covers come from the archive;
 * live rows fill in the days after it. When the ETL adds a partition, `refresh()` notices it
 * (cheap directory scan) and rebuilds the views, so newly archived days replace live ones.
 */
export class HotspotCatalog {
  private signature: string | null = null;
  private info: ArchiveInfo;

  constructor(
    private readonly db: Database,
    archiveDir: string,
  ) {
    this.info = { archiveDir, available: false, partitions: 0, coverage: [], refreshedAt: null };
  }

  get archive(): ArchiveInfo {
    return { ...this.info, coverage: [...this.info.coverage] };
  }

  private get hotspotsDir(): string {
    return path.join(this.info.archiveDir, 'hotspots');
  }

  /** Rebuilds the views if the archive changed on disk. Returns true when it did. */
  async refresh(): Promise<boolean> {
    const files = await listPartitionFiles(this.hotspotsDir);
    const signature = files.map((f) => `${f.path}:${f.size}:${f.mtimeMs}`).join('|');
    if (signature === this.signature) return false;

    const columns = HOTSPOT_COLUMNS.map(([name, type]) => `CAST("${name}" AS ${type}) AS "${name}"`).join(', ');
    const glob = lit(path.join(this.hotspotsDir, '**', '*.parquet'));

    if (files.length) {
      await this.db.run(`
        CREATE OR REPLACE VIEW archive_hotspots AS
        SELECT ${columns}, CAST(NULL AS TIMESTAMP) AS ingested_at, 'archive' AS origin
        FROM read_parquet(${glob}, hive_partitioning = true)`);
      // Only the newest years can overlap with live data; partition pruning keeps this fast globally.
      const maxYear = Math.max(...files.map((f) => f.year));
      await this.db.run(`
        CREATE OR REPLACE TABLE archive_coverage AS
        SELECT satellite, max(acq_date) AS last_date FROM archive_hotspots
        WHERE year >= ${maxYear - 1} GROUP BY satellite`);
    } else {
      await this.db.run(`
        CREATE OR REPLACE VIEW archive_hotspots AS
        SELECT ${columns}, CAST(NULL AS TIMESTAMP) AS ingested_at, 'archive' AS origin
        FROM live_hotspots WHERE false`);
      await this.db.run(`CREATE OR REPLACE TABLE archive_coverage (satellite VARCHAR, last_date DATE)`);
    }

    const names = HOTSPOT_COLUMN_NAMES.map((n) => `l."${n}"`).join(', ');
    await this.db.run(`
      CREATE OR REPLACE VIEW live_hotspots_visible AS
      SELECT ${names}, l.ingested_at, 'live' AS origin
      FROM live_hotspots l
      WHERE NOT EXISTS (
        SELECT 1 FROM archive_coverage c WHERE c.satellite = l.satellite AND l.acq_date <= c.last_date
      )`);
    await this.db.run(`
      CREATE OR REPLACE VIEW hotspots_all AS
      SELECT * FROM archive_hotspots
      UNION ALL
      SELECT * FROM live_hotspots_visible`);

    const coverage = await this.db.all<{ satellite: string; lastDate: string }>(
      `SELECT satellite, CAST(last_date AS VARCHAR) AS "lastDate" FROM archive_coverage ORDER BY satellite`,
    );
    this.info = {
      ...this.info,
      available: files.length > 0,
      partitions: new Set(files.map((f) => path.dirname(f.path))).size,
      coverage,
      refreshedAt: new Date().toISOString(),
    };
    this.signature = signature;
    return true;
  }
}

interface PartitionFile {
  path: string;
  size: number;
  mtimeMs: number;
  year: number;
}

/** Lists <dir>/year=YYYY/country=Name/*.parquet (the ETL's layout) without reading any file. */
async function listPartitionFiles(dir: string): Promise<PartitionFile[]> {
  const result: PartitionFile[] = [];
  for (const yearDir of await readDirSafe(dir)) {
    const year = Number(yearDir.match(/^year=(\d{4})$/)?.[1]);
    if (!year) continue;
    for (const countryDir of await readDirSafe(path.join(dir, yearDir))) {
      if (!countryDir.startsWith('country=')) continue;
      const partition = path.join(dir, yearDir, countryDir);
      for (const file of await readDirSafe(partition)) {
        if (!file.endsWith('.parquet')) continue;
        const full = path.join(partition, file);
        const stat = await fs.stat(full).catch(() => null);
        if (stat) result.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs, year });
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function readDirSafe(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => []);
}
