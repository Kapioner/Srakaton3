import type {
  Bbox,
  CalendarResponse,
  GridResponse,
  MetaResponse,
  Metric,
  PointsResponse,
  SeriesResponse,
  SummaryResponse,
} from '../../shared/api.ts';

export interface Filters {
  bbox?: Bbox | null;
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

async function get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(buildUrl(path, params));
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** GET /api/health (server-only shape, not part of the shared contract). */
export interface HealthResponse {
  ok: boolean;
  duckdb: string;
  harmonizedRows: number | null;
  fixtures: boolean;
}

export const api = {
  health: () => get<HealthResponse>('/api/health'),
  meta: () => get<MetaResponse>('/api/meta'),
  calendar: (f: Filters, granularity: 'month' | 'day' = 'month', metric: Metric = 'h') =>
    get<CalendarResponse>('/api/calendar', { ...f, granularity, metric }),
  summary: (f: Filters) => get<SummaryResponse>('/api/summary', { ...f }),
  series: (f: Filters, by: 'year' | 'month' = 'year') => get<SeriesResponse>('/api/series', { ...f, by }),
  grid: (f: Filters, res = 0.1) => get<GridResponse>('/api/grid', { ...f, res }),
  points: (f: Filters, limit = 50_000) => get<PointsResponse>('/api/points', { ...f, limit }),
  /** Link target for the CSV download button. */
  exportCsvUrl: (f: Filters) => buildUrl('/api/export.csv', { ...f }),
};
