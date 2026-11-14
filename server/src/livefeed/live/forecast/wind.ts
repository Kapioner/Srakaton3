// Real wind at each fire, from Open-Meteo (free, no API key): current 10 m wind speed and direction.
// One HTTP request covers many fires (comma-separated coordinates); results are cached per 0.25 deg cell
// so map pans do not re-ask. Any failure (no internet, rate limit) returns null: the forecast then simply
// has no wind cone, it never fails because of the weather service.
import { LocalProjection, round, type LonLat } from './geo.js';

export interface Wind {
  /** Meteorological convention: direction the wind blows FROM, compass degrees. */
  fromDeg: number;
  speedKmh: number;
  /** Fire spreads downwind: the direction the wind blows TO. */
  towardDeg: number;
  observedAt: string;
  source: 'open-meteo';
}

export interface WindProvider {
  windAt(points: LonLat[]): Promise<(Wind | null)[]>;
}

interface Options {
  baseUrl: string;
  ttlMs: number;
  timeoutMs: number;
  /** Coordinates per request (Open-Meteo accepts many; keep URLs short). */
  batch: number;
}

const DEFAULTS: Options = {
  baseUrl: 'https://api.open-meteo.com/v1/forecast',
  ttlMs: 30 * 60_000,
  timeoutMs: 6_000,
  batch: 50,
};

/** Cache key: 0.25 deg cell, about the resolution of the weather model. */
const cellKey = ([lon, lat]: LonLat) => `${Math.round(lat * 4) / 4},${Math.round(lon * 4) / 4}`;

export class OpenMeteoWind implements WindProvider {
  private readonly options: Options;
  private readonly cache = new Map<string, { at: number; wind: Wind | null }>();

  constructor(options: Partial<Options> = {}, private readonly log?: { warn: (msg: string) => void }) {
    this.options = { ...DEFAULTS, ...options };
  }

  async windAt(points: LonLat[]): Promise<(Wind | null)[]> {
    const now = Date.now();
    const missing = new Map<string, LonLat>();
    for (const p of points) {
      const key = cellKey(p);
      const hit = this.cache.get(key);
      if (!hit || now - hit.at > this.options.ttlMs) missing.set(key, p);
    }

    const keys = [...missing.keys()];
    for (let i = 0; i < keys.length; i += this.options.batch) {
      const chunk = keys.slice(i, i + this.options.batch);
      try {
        const winds = await this.fetchChunk(chunk.map((k) => missing.get(k)!));
        chunk.forEach((k, j) => this.cache.set(k, { at: now, wind: winds[j] ?? null }));
      } catch (err) {
        this.log?.warn(`wind: ${(err as Error).message}`);
        // Remember the failure briefly so a dead network does not slow every request.
        chunk.forEach((k) => this.cache.set(k, { at: now - this.options.ttlMs + 120_000, wind: null }));
      }
    }
    return points.map((p) => this.cache.get(cellKey(p))?.wind ?? null);
  }

  private async fetchChunk(points: LonLat[]): Promise<(Wind | null)[]> {
    const lat = points.map((p) => p[1].toFixed(3)).join(',');
    const lon = points.map((p) => p[0].toFixed(3)).join(',');
    const url = `${this.options.baseUrl}?latitude=${lat}&longitude=${lon}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
    const res = await fetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs) });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const list = (Array.isArray(body) ? body : [body]) as { current?: { time?: string; wind_speed_10m?: number; wind_direction_10m?: number } }[];
    return list.map((item) => {
      const c = item.current;
      if (!c || typeof c.wind_speed_10m !== 'number' || typeof c.wind_direction_10m !== 'number') return null;
      return {
        fromDeg: c.wind_direction_10m,
        speedKmh: c.wind_speed_10m,
        towardDeg: (c.wind_direction_10m + 180) % 360,
        observedAt: c.time ? `${c.time}Z` : new Date().toISOString(),
        source: 'open-meteo' as const,
      };
    });
  }
}

/**
 * Downwind spread envelope for one horizon: a sector opening in the direction the wind blows.
 * Heuristic, not a fire behaviour model: head-fire rate grows with wind (about 3 % of wind speed plus a
 * base rate), and stronger wind narrows the cone. Good enough to show where a fire is likely heading.
 */
export function windCone(center: LonLat, wind: Wind, horizonHours: number): { ring: LonLat[]; reachKm: number; halfAngleDeg: number } {
  const rateKmh = 0.1 + 0.03 * wind.speedKmh;
  const reachKm = Math.min(30, Math.max(0.5, rateKmh * horizonHours));
  const halfAngleDeg = Math.max(12, Math.min(40, 40 - wind.speedKmh * 0.8));
  const projection = new LocalProjection(center);
  const ring: LonLat[] = [round(center)];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const bearing = ((wind.towardDeg - halfAngleDeg + (2 * halfAngleDeg * i) / steps) * Math.PI) / 180;
    ring.push(round(projection.toLonLat([reachKm * Math.sin(bearing), reachKm * Math.cos(bearing)])));
  }
  ring.push(round(center));
  return { ring, reachKm: Math.round(reachKm * 10) / 10, halfAngleDeg: Math.round(halfAngleDeg) };
}

/** Most likely direction and speed of spread for one fire. */
export interface SpreadHeading {
  /** Compass degrees the fire is most likely heading to. */
  headingDeg: number;
  /** Assumed head-fire advance, km/h. */
  rateKmh: number;
  halfAngleDeg: number;
  /** What the heading is based on. */
  basis: 'wind+drift' | 'wind' | 'drift';
}

/**
 * Combines the real wind with the fire's observed drift (vector sum): wind pushes the head of the fire
 * downwind, the drift says where the detections have actually been moving. Low-confidence drift is ignored.
 * Returns null when there is neither wind nor a measurable drift.
 */
export function spreadHeading(
  wind: Wind | null,
  drift: { bearingDeg: number | null; speedKmh: number; confidence: 'low' | 'medium' | 'high' },
): SpreadHeading | null {
  const parts: { deg: number; rate: number }[] = [];
  if (wind) parts.push({ deg: wind.towardDeg, rate: 0.1 + 0.03 * wind.speedKmh });
  const useDrift = drift.bearingDeg !== null && drift.confidence !== 'low' && drift.speedKmh > 0.05;
  if (useDrift) parts.push({ deg: drift.bearingDeg as number, rate: Math.min(3, drift.speedKmh) });
  if (!parts.length) return null;

  const rad = (d: number) => (d * Math.PI) / 180;
  const x = parts.reduce((s, p) => s + p.rate * Math.sin(rad(p.deg)), 0);
  const y = parts.reduce((s, p) => s + p.rate * Math.cos(rad(p.deg)), 0);
  let rateKmh = Math.hypot(x, y);
  let headingDeg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  // Wind and drift pointing opposite ways cancel out: fall back to the wind, the physical driver.
  if (rateKmh < 0.05 && wind) {
    headingDeg = wind.towardDeg;
    rateKmh = 0.1 + 0.03 * wind.speedKmh;
  }
  let halfAngleDeg = wind ? Math.max(12, Math.min(40, 40 - wind.speedKmh * 0.8)) : 30;
  if (wind && useDrift) {
    const diff = Math.abs((((wind.towardDeg - (drift.bearingDeg as number)) % 360) + 540) % 360 - 180);
    if (diff < 45) halfAngleDeg = Math.max(10, halfAngleDeg - 6); // both agree: more certain, narrower cone
  }
  return {
    headingDeg: Math.round(headingDeg),
    rateKmh: Math.round(rateKmh * 100) / 100,
    halfAngleDeg: Math.round(halfAngleDeg),
    basis: wind && useDrift ? 'wind+drift' : wind ? 'wind' : 'drift',
  };
}

const reachFor = (h: SpreadHeading, horizonHours: number) => Math.min(30, Math.max(0.5, h.rateKmh * horizonHours));

/** Sector polygon from the fire towards its heading, for one horizon. */
export function spreadCone(center: LonLat, h: SpreadHeading, horizonHours: number): { ring: LonLat[]; reachKm: number } {
  const reachKm = reachFor(h, horizonHours);
  const projection = new LocalProjection(center);
  const ring: LonLat[] = [round(center)];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const b = ((h.headingDeg - h.halfAngleDeg + (2 * h.halfAngleDeg * i) / steps) * Math.PI) / 180;
    ring.push(round(projection.toLonLat([reachKm * Math.sin(b), reachKm * Math.cos(b)])));
  }
  ring.push(round(center));
  return { ring, reachKm: Math.round(reachKm * 10) / 10 };
}

/** Most likely path: a line from the fire to the tip of the longest cone, plus an arrowhead there. */
export function spreadArrow(center: LonLat, h: SpreadHeading, horizonHours: number): { axis: LonLat[]; head: LonLat[] } {
  const reachKm = reachFor(h, horizonHours);
  const projection = new LocalProjection(center);
  const at = (km: number, deg: number) => {
    const b = (deg * Math.PI) / 180;
    return projection.toLonLat([km * Math.sin(b), km * Math.cos(b)]);
  };
  const tip = at(reachKm, h.headingDeg);
  const size = Math.max(0.35, reachKm * 0.14);
  const [tx, ty] = projection.toKm(tip);
  const back = (side: number) => {
    const b = ((h.headingDeg + 180 + side * 28) * Math.PI) / 180;
    return projection.toLonLat([tx + size * Math.sin(b), ty + size * Math.cos(b)]);
  };
  return { axis: [round(center), round(at(reachKm * 0.9, h.headingDeg))], head: [round(tip), round(back(-1)), round(back(1)), round(tip)] };
}
