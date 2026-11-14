// API contract shared by server/ and web/. Types only: import with `import type`.
//
// Common query parameters (all optional):
//   bbox=minLon,minLat,maxLon,maxLat   region filter; omitted = whole dataset
//   from=YYYY-MM-DD  to=YYYY-MM-DD     inclusive date range; omitted = full range

export type Bbox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export type SensorId = 'modis' | 'viirs-snpp' | 'viirs-jpss1';

/** 'harmonized' = active ~1 km cells per day, scaled to MODIS-equivalent (see docs/PLAN.md). */
export type Metric = 'harmonized' | 'raw_points' | 'raw_cells';

export interface QueryEcho {
  bbox: Bbox | null;
  from: string;
  to: string;
}

// ---- GET /api/meta ---------------------------------------------------------

export interface SensorInfo {
  id: SensorId;
  instrument: 'MODIS' | 'VIIRS';
  satellites: string[];
  from: string;
  to: string;
}

export interface Era {
  id: 'E1' | 'E2' | 'E3';
  fromYear: number;
  toYear: number;
  sensors: SensorId[];
}

export interface CalibrationFactor {
  era: Era['id'];
  month: number;
  /** harmonized = union cells x factor */
  factor: number;
}

export interface MetaResponse {
  dateRange: { from: string; to: string };
  bbox: Bbox;
  countries: string[];
  sensors: SensorInfo[];
  eras: Era[];
  grid: { resolutionDeg: number };
  calibration: { unit: 'modis_equivalent_cells'; factors: CalibrationFactor[] };
}

// ---- GET /api/calendar?granularity=month|day&metric=... --------------------

export interface CalendarCell {
  year: number;
  month: number;
  /** Present only when granularity=day. */
  day?: number;
  value: number;
  /** value / long-term mean for the same calendar month; null when the mean is 0. */
  anomaly: number | null;
  /** 1 = the most active year for this calendar month. */
  rank: number;
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
  cells: CalendarCell[];
  /** Long-term statistics per calendar month over baselineYears. */
  baseline: MonthBaseline[];
  baselineYears: [number, number];
}

// ---- GET /api/summary ------------------------------------------------------

export interface SummaryResponse {
  query: QueryEcho;
  total: number;
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

export interface SeriesPoint {
  year: number;
  /** Present only when by=month. */
  month?: number;
  harmonized: number;
  rawPoints: Record<SensorId, number>;
  rawCells: Record<SensorId, number> & { union: number };
}

export interface SeriesResponse {
  query: QueryEcho & { by: 'year' | 'month' };
  points: SeriesPoint[];
}

// ---- GET /api/grid?res=0.05|0.1 --------------------------------------------
// GeoJSON FeatureCollection of cell centres.

export interface GridFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [lon: number, lat: number] };
  properties: { value: number; detections: number; maxFrp: number };
}

export interface GridResponse {
  type: 'FeatureCollection';
  query: QueryEcho & { res: number };
  features: GridFeature[];
}

// ---- GET /api/points?limit=50000 -------------------------------------------

export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [lon: number, lat: number] };
  properties: {
    date: string;
    time: string;
    sensor: 'MODIS' | 'VIIRS';
    satellite: string;
    confidence: 'low' | 'nominal' | 'high';
    frp: number;
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
// Streamed text/csv attachment with these columns:
export const EXPORT_COLUMNS = [
  'latitude',
  'longitude',
  'acq_date',
  'acq_time',
  'sensor',
  'satellite',
  'confidence',
  'confidence_raw',
  'brightness',
  'frp',
  'daynight',
  'type',
  'country',
] as const;
