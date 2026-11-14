import { CELL_SIZE_DEG, type BBox } from '../domain.js';
import type { Detection, HotspotRepository } from '../repository.js';
import { clusterDetections, type FireCluster } from './clustering.js';
import { circleRing, convexHullRing, round, type LonLat } from './geo.js';
import type { SpreadPredictor } from './predictor.js';

export interface SituationQuery {
  bbox: BBox | null;
  /** How far back detections are considered part of the current picture. */
  lookbackHours: number;
  /** Maximum number of fires returned, largest first. */
  limit: number;
  now?: Date;
}

export interface ForecastQuery extends SituationQuery {
  horizonsHours: number[];
}

interface Feature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  metadata: Record<string, unknown>;
  features: Feature[];
}

/** A fire counts as still burning when it was last seen within this many hours. */
const ACTIVE_WITHIN_HOURS = 24;

/** Turns harmonized detections into "what burns now" and "where it is heading" map layers. */
export class SituationService {
  constructor(
    private readonly hotspots: HotspotRepository,
    private readonly predictor: SpreadPredictor,
  ) {}

  /** Current fires as GeoJSON polygons (outline of each fire's active grid cells). */
  async situation(query: SituationQuery): Promise<FeatureCollection> {
    const now = query.now ?? new Date();
    const clusters = await this.loadClusters(query, now);
    return {
      type: 'FeatureCollection',
      metadata: { generatedAt: now.toISOString(), lookbackHours: query.lookbackHours, fires: clusters.length },
      features: clusters.map((cluster) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [outline(cluster)] },
        properties: { kind: 'fire', ...describe(cluster, now) },
      })),
    };
  }

  /**
   * Forecast for fires that are still active: per fire one `track` line (observed + predicted
   * positions) and one `forecast_area` polygon per horizon.
   */
  async forecast(query: ForecastQuery): Promise<FeatureCollection> {
    const now = query.now ?? new Date();
    const clusters = (await this.loadClusters(query, now)).filter((c) => describe(c, now).active);
    const features: Feature[] = [];

    for (const cluster of clusters) {
      const forecast = this.predictor.predict(cluster, query.horizonsHours);
      const summary = {
        clusterId: forecast.clusterId,
        speedKmh: forecast.speedKmh,
        bearingDeg: forecast.bearingDeg,
        growthKmh: forecast.growthKmh,
        confidence: forecast.confidence,
      };
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [...forecast.observedTrack.map((p) => p.center), ...forecast.steps.map((s) => s.center)].map(round),
        },
        properties: { kind: 'track', ...summary, observedPoints: forecast.observedTrack.length },
      });
      for (const step of forecast.steps) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [circleRing(step.center, step.radiusKm)] },
          properties: { kind: 'forecast_area', ...summary, ...step, center: round(step.center) },
        });
      }
    }

    return {
      type: 'FeatureCollection',
      metadata: {
        generatedAt: now.toISOString(),
        method: this.predictor.method,
        lookbackHours: query.lookbackHours,
        horizonsHours: query.horizonsHours,
        fires: clusters.length,
        disclaimer:
          'Trend extrapolation of satellite detections. No wind, fuel or terrain input. Not for operational decisions on its own.',
      },
      features,
    };
  }

  private async loadClusters(query: SituationQuery, now: Date): Promise<FireCluster[]> {
    const from = new Date(now.getTime() - query.lookbackHours * 3_600_000);
    const detections = await this.hotspots.detections({ bbox: query.bbox, from, to: now });
    return clusterDetections(detections)
      .sort((a, b) => b.activeCells - a.activeCells)
      .slice(0, query.limit);
  }
}

function describe(cluster: FireCluster, now: Date) {
  const times = cluster.detections.map((d) => d.t);
  const lastSeen = Math.max(...times);
  const lat = mean(cluster.detections.map((d) => d.lat));
  const lon = mean(cluster.detections.map((d) => d.lon));
  const cellKm2 = (CELL_SIZE_DEG * 110.574) * (CELL_SIZE_DEG * 111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    clusterId: cluster.id,
    centroid: round([lon, lat]),
    activeCells: cluster.activeCells,
    approxAreaKm2: Math.round(cluster.activeCells * cellKm2 * 10) / 10,
    detections: cluster.detections.length,
    maxFrpMw: Math.round(Math.max(...cluster.detections.map((d) => d.frp)) * 10) / 10,
    firstSeen: new Date(Math.min(...times)).toISOString(),
    lastSeen: new Date(lastSeen).toISOString(),
    active: now.getTime() - lastSeen <= ACTIVE_WITHIN_HOURS * 3_600_000,
  };
}

/** Convex hull around the corners of every active cell; always a valid polygon. */
function outline(cluster: FireCluster): LonLat[] {
  const corners = new Map<string, LonLat>();
  for (const { cellX, cellY } of cluster.detections as Detection[]) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const corner: LonLat = [(cellX + dx) * CELL_SIZE_DEG, (cellY + dy) * CELL_SIZE_DEG];
      corners.set(corner.join(','), corner);
    }
  }
  return convexHullRing([...corners.values()]);
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
