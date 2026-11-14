import { CLUSTER_CELL_DEG, type BBox } from '../domain.js';
import type { Detection, HotspotRepository } from '../repository.js';
import { clusterDetections, type FireCluster } from './clustering.js';
import { circleRing, convexHullRing, round, type LonLat } from './geo.js';
import { simulateLandCover } from './landCover.js';
import type { SpreadPredictor } from './predictor.js';
import { spreadArrow, spreadCone, spreadHeading, type Wind, type WindProvider } from './wind.js';

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
    /** Real wind for the downwind cones; null = forecast without wind (tests, offline). */
    private readonly wind: WindProvider | null = null,
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
        properties: { kind: 'fire', ...describe(cluster, now), landCover: simulateLandCover(centroidOf(cluster)) },
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
    const forecasts = clusters.map((cluster) => this.predictor.predict(cluster, query.horizonsHours));
    // Wind at the latest observed position of each fire (one batched request).
    const origins = forecasts.map((f, i) => (f.observedTrack.at(-1)?.center ?? centroidOf(clusters[i])) as LonLat);
    const winds: (Wind | null)[] = this.wind ? await this.wind.windAt(origins) : origins.map(() => null);

    for (const [i, forecast] of forecasts.entries()) {
      const wind = winds[i];
      const summary = {
        clusterId: forecast.clusterId,
        speedKmh: forecast.speedKmh,
        bearingDeg: forecast.bearingDeg,
        growthKmh: forecast.growthKmh,
        confidence: forecast.confidence,
        wind,
      };
      // Where the fire most likely heads: wind + observed drift. Cones widest horizon first, so the
      // short-term (most likely) band is drawn on top.
      const heading = spreadHeading(wind, forecast);
      if (heading) {
        const spread = { ...summary, headingDeg: heading.headingDeg, rateKmh: heading.rateKmh, halfAngleDeg: heading.halfAngleDeg, basis: heading.basis };
        for (const horizonHours of [...query.horizonsHours].sort((a, b) => b - a)) {
          const cone = spreadCone(origins[i], heading, horizonHours);
          features.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [cone.ring] },
            properties: { kind: 'spread_cone', ...spread, horizonHours, reachKm: cone.reachKm },
          });
        }
        const arrow = spreadArrow(origins[i], heading, Math.max(...query.horizonsHours));
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: arrow.axis }, properties: { kind: 'spread_axis', ...spread } });
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [arrow.head] }, properties: { kind: 'spread_head', ...spread } });
      }
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
        method: this.wind ? `${this.predictor.method}+spread-cone(wind+drift)` : `${this.predictor.method}+spread-cone(drift)`,
        wind: this.wind ? 'Open-Meteo current 10 m wind at each fire' : null,
        landCover: 'simulated AI prototype',
        lookbackHours: query.lookbackHours,
        horizonsHours: query.horizonsHours,
        fires: clusters.length,
        disclaimer: this.wind
          ? 'Spread cones combine real wind with the observed drift of satellite detections (heuristic). No fuel or terrain input. Not for operational decisions on its own.'
          : 'Trend extrapolation of satellite detections. No wind, fuel or terrain input. Not for operational decisions on its own.',
      },
      features,
    };
  }

  private async loadClusters(query: SituationQuery, now: Date): Promise<FireCluster[]> {
    const from = new Date(now.getTime() - query.lookbackHours * 3_600_000);
    const detections = await this.hotspots.detections({ bbox: query.bbox, from, to: now, vegetationOnly: true });
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
  const cellKm2 = (CLUSTER_CELL_DEG * 110.574) * (CLUSTER_CELL_DEG * 111.32 * Math.cos((lat * Math.PI) / 180));
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
      const corner: LonLat = [(cellX + dx) * CLUSTER_CELL_DEG, (cellY + dy) * CLUSTER_CELL_DEG];
      corners.set(corner.join(','), corner);
    }
  }
  return convexHullRing([...corners.values()]);
}

function centroidOf(cluster: FireCluster): LonLat {
  return [mean(cluster.detections.map((d) => d.lon)), mean(cluster.detections.map((d) => d.lat))];
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
