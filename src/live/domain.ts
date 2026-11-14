/** Domain types and constants of the live (near-real-time) feature. */

export const SENSORS = ['MODIS', 'VIIRS_SNPP', 'VIIRS_NOAA20', 'VIIRS_NOAA21'] as const;
export type Sensor = (typeof SENSORS)[number];

export const WINDOWS = ['24h', '48h', '7d'] as const;
export type FeedWindow = (typeof WINDOWS)[number];

/** Region tokens exactly as used in FIRMS active-fire file names. */
export const REGIONS = [
  'Global',
  'Europe',
  'Canada',
  'Alaska',
  'USA_contiguous_and_Hawaii',
  'Central_America',
  'South_America',
  'Northern_and_Central_Africa',
  'Southern_Africa',
  'Russia_Asia',
  'South_Asia',
  'SouthEast_Asia',
  'Australia_NewZealand',
] as const;
export type Region = (typeof REGIONS)[number];

/** Satellite names as written by the ETL (etl/src/sql.ts). */
export const SATELLITES = ['Terra', 'Aqua', 'S-NPP', 'NOAA-20', 'NOAA-21'] as const;

export const CONFIDENCE_CLASSES = ['low', 'nominal', 'high'] as const;
export type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number];

/** [west, south, east, north] in degrees. */
export type BBox = [number, number, number, number];

/** What the ingester pulls from FIRMS. Set by the frontend, persisted in DuckDB. */
export interface IngestScope {
  region: Region;
  sensors: Sensor[];
  window: FeedWindow;
  /** Optional spatial filter applied on top of the FIRMS region file. */
  bbox: BBox | null;
  /** Delay between the end of one ingest run and the start of the next. */
  pollIntervalSeconds: number;
}

/** Realtime default: the whole world, every sensor, refreshed every 30 seconds. */
export const DEFAULT_SCOPE: IngestScope = {
  region: 'Global',
  sensors: [...SENSORS],
  window: '24h',
  bbox: null,
  pollIntervalSeconds: 30,
};

/**
 * What the user is doing in the frontend. Only `realtime` pulls from FIRMS:
 * browsing the archive or working with a forecast freezes the live data.
 */
export const MODES = ['realtime', 'archive', 'forecast'] as const;
export type Mode = (typeof MODES)[number];

/**
 * Grid used only to group detections into individual fires for the situation map and the forecast
 * (0.01° ≈ 1.1 km, about one MODIS pixel). Harmonization is the ETL's job, not this module's.
 */
export const CLUSTER_CELL_DEG = 0.01;

export function isValidBBox(bbox: unknown): bbox is BBox {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((v) => Number.isFinite(v))) return false;
  const [w, s, e, n] = bbox as BBox;
  return w >= -180 && e <= 180 && s >= -90 && n <= 90 && w < e && s < n;
}
