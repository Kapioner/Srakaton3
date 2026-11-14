/** Small planar-geometry helpers; accurate enough at the scale of a single fire (tens of km). */

export type LonLat = [number, number];
export type XY = [number, number];

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/** Local tangent-plane projection around an origin: degrees ↔ kilometres east/north. */
export class LocalProjection {
  private readonly kmPerDegLon: number;

  constructor(private readonly origin: LonLat) {
    this.kmPerDegLon = KM_PER_DEG_LON_EQUATOR * Math.cos((origin[1] * Math.PI) / 180);
  }

  toKm([lon, lat]: LonLat): XY {
    return [(lon - this.origin[0]) * this.kmPerDegLon, (lat - this.origin[1]) * KM_PER_DEG_LAT];
  }

  toLonLat([x, y]: XY): LonLat {
    return [this.origin[0] + x / this.kmPerDegLon, this.origin[1] + y / KM_PER_DEG_LAT];
  }
}

/** Closed polygon ring approximating a circle of the given radius. */
export function circleRing(center: LonLat, radiusKm: number, vertices = 32): LonLat[] {
  const projection = new LocalProjection(center);
  const ring: LonLat[] = [];
  for (let i = 0; i <= vertices; i++) {
    const angle = (2 * Math.PI * i) / vertices;
    ring.push(round(projection.toLonLat([radiusKm * Math.cos(angle), radiusKm * Math.sin(angle)])));
  }
  return ring;
}

/** Convex hull (Andrew's monotone chain) returned as a closed ring. */
export function convexHullRing(points: LonLat[]): LonLat[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: LonLat, a: LonLat, b: LonLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (input: LonLat[]) => {
    const chain: LonLat[] = [];
    for (const point of input) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  const hull = [...build(sorted), ...build(sorted.reverse())].map(round);
  return [...hull, hull[0]];
}

/** Compass bearing (0° = north, 90° = east) of a displacement vector. */
export function bearingDeg([dx, dy]: XY): number {
  return (Math.atan2(dx, dy) * 180) / Math.PI + (dx < 0 ? 360 : 0);
}

export function round([lon, lat]: LonLat): LonLat {
  return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
}
