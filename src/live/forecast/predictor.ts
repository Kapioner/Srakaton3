import type { Detection } from '../repository.js';
import type { FireCluster } from './clustering.js';
import { bearingDeg, LocalProjection, type LonLat, type XY } from './geo.js';

export interface ForecastStep {
  horizonHours: number;
  validAt: string;
  center: LonLat;
  radiusKm: number;
}

export interface ClusterForecast {
  clusterId: string;
  /** Observed positions of the fire front, one per group of satellite overpasses. */
  observedTrack: { at: string; center: LonLat; detections: number }[];
  speedKmh: number;
  /** Direction of travel, compass degrees; `null` when the fire shows no measurable drift. */
  bearingDeg: number | null;
  growthKmh: number;
  confidence: 'low' | 'medium' | 'high';
  steps: ForecastStep[];
}

/** Strategy: how a fire's future position is estimated. Swap in a wind/fuel-aware model here. */
export interface SpreadPredictor {
  readonly method: string;
  predict(cluster: FireCluster, horizonsHours: number[]): ClusterForecast;
}

export interface DriftPredictorOptions {
  /** Detections closer in time than this belong to the same observation epoch. */
  epochGapMinutes: number;
  /** Faster apparent motion is treated as a sampling artefact and capped. */
  maxSpeedKmh: number;
  /** Radius added per forecast hour to express what the model cannot know (wind, fuel, terrain). */
  uncertaintyKmh: number;
  /** Lower bound of a fire's radius: roughly one MODIS pixel. */
  minRadiusKm: number;
}

const DEFAULTS: DriftPredictorOptions = {
  epochGapMinutes: 90,
  maxSpeedKmh: 3,
  uncertaintyKmh: 0.2,
  minRadiusKm: 0.5,
};

interface Epoch {
  /** Hours since the first epoch. */
  hours: number;
  timeMs: number;
  center: XY;
  radiusKm: number;
  weight: number;
}

/**
 * Kinematic extrapolation of the active fire front.
 *
 * Active-fire detections mark where a fire is burning at overpass time, so the centroid of each
 * overpass group traces the front. A weighted linear fit through those centroids gives a velocity,
 * a second fit through their spread gives a growth rate, and both are projected forward.
 * This is a trend extrapolation, not a physical model: it knows nothing about wind, fuel or terrain,
 * which is why the predicted area widens with the horizon.
 */
export class CentroidDriftPredictor implements SpreadPredictor {
  readonly method = 'centroid-drift-v1';
  private readonly options: DriftPredictorOptions;

  constructor(options: Partial<DriftPredictorOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  predict(cluster: FireCluster, horizonsHours: number[]): ClusterForecast {
    const { maxSpeedKmh, uncertaintyKmh } = this.options;
    const origin = meanLonLat(cluster.detections);
    const projection = new LocalProjection(origin);
    const epochs = this.buildEpochs(cluster.detections, projection);
    const last = epochs[epochs.length - 1];

    const fitX = weightedLinearFit(epochs, (e) => e.center[0]);
    const fitY = weightedLinearFit(epochs, (e) => e.center[1]);
    const fitRadius = weightedLinearFit(epochs, (e) => e.radiusKm);

    let velocity: XY = [fitX.slope, fitY.slope];
    const rawSpeed = Math.hypot(...velocity);
    if (rawSpeed > maxSpeedKmh) velocity = [(velocity[0] / rawSpeed) * maxSpeedKmh, (velocity[1] / rawSpeed) * maxSpeedKmh];
    const speed = Math.min(rawSpeed, maxSpeedKmh);
    const growth = clamp(fitRadius.slope, 0, maxSpeedKmh);
    const fitError = Math.hypot(fitX.rms, fitY.rms);

    return {
      clusterId: cluster.id,
      observedTrack: epochs.map((e) => ({
        at: new Date(e.timeMs).toISOString(),
        center: projection.toLonLat(e.center),
        detections: e.weight,
      })),
      speedKmh: round2(speed),
      bearingDeg: speed >= 0.05 ? Math.round(bearingDeg(velocity)) : null,
      growthKmh: round2(growth),
      confidence: rateConfidence(epochs, speed, rawSpeed > maxSpeedKmh, fitError),
      steps: horizonsHours.map((h) => ({
        horizonHours: h,
        validAt: new Date(last.timeMs + h * 3_600_000).toISOString(),
        center: projection.toLonLat([last.center[0] + velocity[0] * h, last.center[1] + velocity[1] * h]),
        radiusKm: round2(last.radiusKm + fitError + (growth + uncertaintyKmh) * h),
      })),
    };
  }

  /** Groups detections into observation epochs (near-simultaneous satellite overpasses). */
  private buildEpochs(detections: Detection[], projection: LocalProjection): Epoch[] {
    const sorted = [...detections].sort((a, b) => a.t - b.t);
    const groups: Detection[][] = [];
    for (const d of sorted) {
      const current = groups[groups.length - 1];
      if (current && d.t - current[current.length - 1].t <= this.options.epochGapMinutes * 60_000) current.push(d);
      else groups.push([d]);
    }

    const start = mean(groups[0].map((d) => d.t));
    return groups.map((group) => {
      const points = group.map((d) => projection.toKm([d.lon, d.lat]));
      const center: XY = [mean(points.map((p) => p[0])), mean(points.map((p) => p[1]))];
      const rmsDistance = Math.sqrt(mean(points.map((p) => (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2)));
      const timeMs = mean(group.map((d) => d.t));
      return {
        hours: (timeMs - start) / 3_600_000,
        timeMs,
        center,
        // 2 × RMS distance encloses the bulk of the detections of a compact fire.
        radiusKm: Math.max(this.options.minRadiusKm, 2 * rmsDistance),
        weight: group.length,
      };
    });
  }
}

function rateConfidence(epochs: Epoch[], speed: number, capped: boolean, fitError: number): ClusterForecast['confidence'] {
  const spanHours = epochs[epochs.length - 1].hours;
  if (epochs.length < 3 || capped) return 'low';
  const consistent = fitError <= Math.max(1, 0.25 * speed * spanHours);
  return epochs.length >= 4 && spanHours >= 12 && consistent ? 'high' : 'medium';
}

/** Weighted least-squares line through (epoch.hours, value). With one epoch the slope is 0. */
function weightedLinearFit(epochs: Epoch[], value: (e: Epoch) => number): { slope: number; rms: number } {
  const totalWeight = epochs.reduce((sum, e) => sum + e.weight, 0);
  const meanT = epochs.reduce((sum, e) => sum + e.weight * e.hours, 0) / totalWeight;
  const meanV = epochs.reduce((sum, e) => sum + e.weight * value(e), 0) / totalWeight;
  const varT = epochs.reduce((sum, e) => sum + e.weight * (e.hours - meanT) ** 2, 0);
  if (varT === 0) return { slope: 0, rms: 0 };
  const slope = epochs.reduce((sum, e) => sum + e.weight * (e.hours - meanT) * (value(e) - meanV), 0) / varT;
  const residual = epochs.reduce((sum, e) => sum + e.weight * (value(e) - meanV - slope * (e.hours - meanT)) ** 2, 0);
  return { slope, rms: Math.sqrt(residual / totalWeight) };
}

function meanLonLat(detections: Detection[]): LonLat {
  return [mean(detections.map((d) => d.lon)), mean(detections.map((d) => d.lat))];
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;
