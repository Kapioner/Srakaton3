import type { Bbox } from '../../shared/api.ts';

export class BadRequest extends Error {
  statusCode = 400;
}

export interface CommonParams {
  bbox: Bbox | null;
  from: string | null;
  to: string | null;
  /** FIRMS country name (spaces or underscores); filters by the data's country attribute, not a rectangle. */
  country?: string | null;
}

/** Country names as stored by the ETL (FIRMS file names: underscores instead of spaces). */
function parseCountry(value: unknown): string | null {
  if (value === undefined || value === '') return null;
  const name = String(value).trim().replace(/\s+/g, '_');
  if (!/^[\p{L}\p{N}_.,'()-]{1,80}$/u.test(name)) throw new BadRequest('"country" contains unexpected characters');
  return name;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(name: string, value: unknown): string | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`"${name}" must be a date in YYYY-MM-DD format`);
  }
  return value;
}

function parseBbox(value: unknown): Bbox | null {
  if (value === undefined || value === '') return null;
  const parts = String(value).split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new BadRequest('"bbox" must be minLon,minLat,maxLon,maxLat');
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat || minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new BadRequest('"bbox" is out of range or has min >= max');
  }
  return [minLon, minLat, maxLon, maxLat];
}

export function parseCommon(query: Record<string, unknown>): CommonParams {
  const from = parseDate('from', query.from);
  const to = parseDate('to', query.to);
  if (from && to && from > to) throw new BadRequest('"from" must not be after "to"');
  return { bbox: parseBbox(query.bbox), from, to, country: parseCountry(query.country) };
}

export function parseEnum<T extends string>(name: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback;
  if (!allowed.includes(value as T)) {
    throw new BadRequest(`"${name}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function parseNumber(name: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new BadRequest(`"${name}" must be a number between ${min} and ${max}`);
  }
  return n;
}
