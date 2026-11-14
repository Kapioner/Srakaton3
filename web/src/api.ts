import type {
  Bbox,
  CalendarResponse,
  GridResponse,
  HealthResponse,
  MetaResponse,
  Metric,
  PointsResponse,
  RegionsResponse,
  LiveForecast,
  LiveSituation,
  LiveStatus,
  ReportResponse,
  SeriesResponse,
  SummaryResponse,
} from '../../shared/api.ts';

export interface Filters {
  bbox?: Bbox | null;
  /** FIRMS country name: filters by the data's country attribute instead of a rectangle. */
  country?: string | null;
  from?: string | null;
  to?: string | null;
}

function buildUrl(path: string, params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function get<T>(path: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(buildUrl(path, params), { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Only the query fields the API knows (the panel keeps a label too). */
const params = (f: Filters) => ({ bbox: f.bbox, country: f.country, from: f.from, to: f.to });

export const api = {
  health: () => get<HealthResponse>('/api/health'),
  meta: () => get<MetaResponse>('/api/meta'),
  regions: () => get<RegionsResponse>('/api/regions'),
  calendar: (f: Filters, signal?: AbortSignal, granularity: 'month' | 'day' = 'month', metric: Metric = 'h') =>
    get<CalendarResponse>('/api/calendar', { ...params(f), granularity, metric }, signal),
  summary: (f: Filters, signal?: AbortSignal) => get<SummaryResponse>('/api/summary', params(f), signal),
  series: (f: Filters, signal?: AbortSignal, by: 'year' | 'month' = 'year') =>
    get<SeriesResponse>('/api/series', { ...params(f), by }, signal),
  report: (f: Filters, signal?: AbortSignal) => get<ReportResponse>('/api/report', { bbox: f.bbox, country: f.country }, signal),
  grid: (f: Filters, signal?: AbortSignal, res = 0.1) => get<GridResponse>('/api/grid', { ...params(f), res }, signal),
  points: (f: Filters, signal?: AbortSignal, limit = 5_000) => get<PointsResponse>('/api/points', { ...params(f), limit }, signal),
  live: {
    status: (signal?: AbortSignal) => get<LiveStatus>('/api/live/status', {}, signal),
    situation: (bbox: Bbox | null, signal?: AbortSignal) => get<LiveSituation>('/api/live/situation', { bbox, hours: 24, limit: 60 }, signal),
    forecast: (bbox: Bbox | null, signal?: AbortSignal) => get<LiveForecast>('/api/live/forecast', { bbox, limit: 60 }, signal),
  },
  /** Link target for the CSV download button. */
  exportCsvUrl: (f: Filters) => buildUrl('/api/export.csv', params(f)),
};

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
