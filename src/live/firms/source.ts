import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FeedWindow, Region, Sensor } from '../domain.js';

/** A FIRMS CSV downloaded to local disk, ready to be loaded by DuckDB. */
export interface DownloadedFeed {
  url: string;
  filePath: string;
  dispose(): void;
}

/**
 * Strategy: where hotspot CSVs come from. The default implementation reads the public
 * active-fire files; a MAP_KEY-based `/api/area` source can be added without touching the ingester.
 */
export interface HotspotSource {
  /** Returns `null` when the upstream file has not changed since the last download. */
  download(sensor: Sensor, region: Region, window: FeedWindow): Promise<DownloadedFeed | null>;
  /** Forgets change-detection state (e.g. after the scope changed). */
  reset(): void;
}

/** Directory and file-name prefix of each sensor on the FIRMS active-fire server. */
const FEEDS: Record<Sensor, { dir: string; prefix: string }> = {
  MODIS: { dir: 'modis-c6.1', prefix: 'MODIS_C6_1' },
  VIIRS_SNPP: { dir: 'suomi-npp-viirs-c2', prefix: 'SUOMI_VIIRS_C2' },
  VIIRS_NOAA20: { dir: 'noaa-20-viirs-c2', prefix: 'J1_VIIRS_C2' },
  VIIRS_NOAA21: { dir: 'noaa-21-viirs-c2', prefix: 'J2_VIIRS_C2' },
};

export function feedUrl(baseUrl: string, sensor: Sensor, region: Region, window: FeedWindow): string {
  const { dir, prefix } = FEEDS[sensor];
  return `${baseUrl}/${dir}/csv/${prefix}_${region}_${window}.csv`;
}

/** Keyless FIRMS active-fire CSV files (24h / 48h / 7d per region and sensor). */
export class ActiveFireFeedSource implements HotspotSource {
  /** Validators from the last successful download, per URL, for conditional GETs. */
  private readonly validators = new Map<string, { etag?: string; lastModified?: string }>();

  constructor(
    private readonly baseUrl: string,
    private readonly tmpDir: string,
    private readonly timeoutMs = 120_000,
  ) {}

  async download(sensor: Sensor, region: Region, window: FeedWindow): Promise<DownloadedFeed | null> {
    const url = feedUrl(this.baseUrl, sensor, region, window);
    const known = this.validators.get(url);
    const headers: Record<string, string> = {};
    if (known?.etag) headers['If-None-Match'] = known.etag;
    if (known?.lastModified) headers['If-Modified-Since'] = known.lastModified;

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.status === 304) return null;
    if (!response.ok || !response.body) throw new Error(`FIRMS responded ${response.status} for ${url}`);

    fs.mkdirSync(this.tmpDir, { recursive: true });
    const filePath = path.join(this.tmpDir, `${sensor}_${region}_${window}_${Date.now()}.csv`);
    const dispose = () => fs.rmSync(filePath, { force: true });
    try {
      await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(filePath));
      assertLooksLikeHotspotCsv(filePath, url);
    } catch (error) {
      dispose();
      throw error;
    }

    this.validators.set(url, {
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    });
    return { url, filePath, dispose };
  }

  reset(): void {
    this.validators.clear();
  }
}

/** Guards against HTML error pages served with a 200 status. */
function assertLooksLikeHotspotCsv(filePath: string, url: string): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(256);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const firstLine = head.subarray(0, read).toString('utf8').split('\n')[0];
    if (!firstLine.includes('latitude') || !firstLine.includes('acq_date')) {
      throw new Error(`Unexpected content from ${url}: "${firstLine.slice(0, 80)}"`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
