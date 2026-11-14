// API contract shared by server/ and web/. Types only (plus one constant): import with `import type`.
//
// Data comes from the ETL output (see CLAUDE.md, "Chosen method"):
//   harmonized/  one row per 0.1 deg cell x day: h, h_modis, h_viirs, n_modis, n_viirs
//   hotspots/    normalized raw detections (all sensors, common schema)
//   calibration/ k factors per satellite x FRP class, relative to MODIS Aqua
//
// Unit of every harmonized value: Aqua-equivalent fire cell-days (FIRE_UNIT).
//
// Common query parameters (all optional):
//   bbox=minLon,minLat,maxLon,maxLat   region filter; omitted = whole dataset
//   from=YYYY-MM-DD  to=YYYY-MM-DD     inclusive date range; omitted = full range

export const FIRE_UNIT = 'Aqua-equivalent fire cell-days';

export type Bbox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export type Satellite = 'Terra' | 'Aqua' | 'S-NPP' | 'NOAA-20' | 'NOAA-21';

/**
 * What a calendar/series value counts:
 *   h        harmonized estimate from all satellites (the default)
 *   h_modis  the same estimate from MODIS only (null where MODIS did not fly)
 *   h_viirs  the same estimate from VIIRS only (null before 2012)
 *   raw      raw vegetation-fire detections, MODIS + VIIRS (not comparable across years)
 */
export type Metric = 'h' | 'h_modis' | 'h_viirs' | 'raw';

/** Where the numbers come from: the ETL Parquet dataset, or the bundled sample responses. */
export type DataSource = 'parquet' | 'fixtures';

export interface QueryEcho {
  bbox: Bbox | null;
  from: string;
  to: string;
}

// ---- GET /api/meta ---------------------------------------------------------

export interface SatelliteInfo {
  satellite: Satellite;
  sensor: 'MODIS' | 'VIIRS';
  from: string;
  to: string;
}

export interface CalibrationFactor {
  satellite: Satellite;
  /** FRP class: 0 = below frpEdges[0] MW ... last = at or above the last edge. */
  cls: number;
  /** Fire cell-days of this satellite per cell-day of the reference (Aqua), for the dataset's region. */
  k: number;
}

export interface MetaResponse {
  source: DataSource;
  dateRange: { from: string; to: string };
  bbox: Bbox;
  countries: string[];
  satellites: SatelliteInfo[];
  harmonization: {
    unit: typeof FIRE_UNIT;
    reference: Satellite;
    fineGridDeg: number;
    outGridDeg: number;
    frpEdges: number[];
    factors: CalibrationFactor[];
    /** Mean |ln(h_viirs / h_modis)| over years where both fly: the "sensor no longer matters" check. */
    sensorAgreement: { years: number; meanAbsLogRatio: number } | null;
  };
}

// ---- GET /api/calendar?granularity=month|day&metric=h|h_modis|h_viirs|raw ---

export interface CalendarCell {
  year: number;
  month: number;
  /** Present only when granularity=day. */
  day?: number;
  /** null when the chosen metric has no data for this period (e.g. h_viirs before 2012). */
  value: number | null;
  /** value / long-term mean for the same calendar month; null when undefined. */
  anomaly: number | null;
  /** 1 = the most active year for this calendar month. */
  rank: number | null;
}

export interface MonthBaseline {
  month: number;
  mean: number;
  std: number;
  min: number;
  max: number;
}

export interface CalendarResponse {
  query: QueryEcho & { granularity: 'month' | 'day'; metric: Metric };
  unit: string;
  cells: CalendarCell[];
  /** Long-term statistics per calendar month over baselineYears. */
  baseline: MonthBaseline[];
  baselineYears: [number, number];
}

// ---- GET /api/summary ------------------------------------------------------

export interface SummaryResponse {
  query: QueryEcho;
  unit: string;
  /** Harmonized total (h) in the selected region and period. */
  total: number;
  rawDetections: number;
  activeDays: number;
  peakDay: { date: string; value: number } | null;
  peakMonth: { year: number; month: number; value: number } | null;
  peakYear: { year: number; value: number } | null;
  /** The selected period against the same calendar period in other years. */
  comparison: {
    periodValue: number;
    baselineMean: number;
    ratio: number | null;
    rank: number;
    outOf: number;
    baselineYears: [number, number];
  };
}

// ---- GET /api/series?by=year|month -----------------------------------------
// Harmonized vs raw per period: the "before / after harmonization" chart.

export interface SeriesPoint {
  year: number;
  /** Present only when by=month. */
  month?: number;
  h: number;
  hModis: number | null;
  hViirs: number | null;
  nModis: number;
  nViirs: number;
}

export interface SeriesResponse {
  query: QueryEcho & { by: 'year' | 'month' };
  unit: string;
  points: SeriesPoint[];
}

// ---- GET /api/grid?res=0.1|0.25|0.5 ----------------------------------------
// GeoJSON FeatureCollection of cell centres (the ETL stores 0.1 deg cells; coarser res aggregates them).

export interface GridFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [lon: number, lat: number] };
  properties: { h: number; detections: number; activeDays: number };
}

export interface GridResponse {
  type: 'FeatureCollection';
  /** `res` is the cell size actually used: the server coarsens it on big regions (GRID_MAX_CELLS). */
  query: QueryEcho & { res: number };
  /** true when more cells matched than the server limit (the strongest ones are kept). */
  truncated?: boolean;
  features: GridFeature[];
}

// ---- GET /api/report ---------------------------------------------------------
// The ETL report on the page: what the raw data looks like before harmonization, what the type filter
// removes, and the calibration factors. Region filter (bbox) only: it always covers all years.

export interface ReportResponse {
  query: { bbox: Bbox | null };
  /** All detections (every type) per year and satellite: shows the jumps when satellites are added. */
  rawBySatellite: { year: number; satellite: Satellite; n: number }[];
  /** Detections per year and FIRMS type: 0 vegetation fire (kept), 1 volcano, 2 static land source, 3 offshore. */
  byType: { year: number; type: number; n: number }[];
  /** k = fire cell-days of a satellite per cell-day of the reference, per FRP class. */
  calibration: { satellite: Satellite; cls: number; k: number; nSat: number; nRef: number }[];
  frpEdges: number[];
  reference: Satellite;
}

// ---- GET /api/regions --------------------------------------------------------
// Countries present in the dataset, with the extent of their fire activity (for the region picker).

export interface Region {
  country: string;
  bbox: Bbox;
  /** Harmonized total over the whole dataset. */
  h: number;
}

export interface RegionsResponse {
  source: DataSource;
  regions: Region[];
}

// ---- GET /api/health -------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  duckdb: string;
  source: DataSource;
  /** Why the server fell back to fixtures, if it did. */
  reason: string | null;
  parquetDir: string;
  limits: { memoryLimit: string; threads: number; queryTimeoutMs: number; gridMaxCells: number; exportMaxRows: number };
}

// ---- GET /api/points?limit=50000 -------------------------------------------
// Raw vegetation-fire detections (type 0) for high zoom levels.

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [lon: number, lat: number] };
  properties: {
    date: string;
    time: string;
    sensor: 'MODIS' | 'VIIRS';
    satellite: Satellite;
    confidence: 'low' | 'nominal' | 'high' | null;
    frp: number | null;
    daynight: 'D' | 'N';
  };
}

export interface PointsResponse {
  type: 'FeatureCollection';
  query: QueryEcho & { limit: number };
  /** true when more points matched than `limit`. */
  truncated: boolean;
  features: PointFeature[];
}

// ---- GET /api/export.csv ---------------------------------------------------
// Streamed text/csv attachment of normalized detections in the search, with these columns:
export const EXPORT_COLUMNS = [
  'latitude',
  'longitude',
  'acq_date',
  'acq_time',
  'sensor',
  'satellite',
  'confidence',
  'confidence_raw',
  'frp',
  'bt_mir',
  'bt_tir',
  'daynight',
  'type',
  'version',
  'country',
] as const;
