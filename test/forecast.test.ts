import assert from 'node:assert/strict';
import test from 'node:test';
import { CELL_SIZE_DEG } from '../src/live/domain.js';
import { clusterDetections } from '../src/live/forecast/clustering.js';
import { CentroidDriftPredictor } from '../src/live/forecast/predictor.js';
import type { Detection } from '../src/live/repository.js';

const KM_PER_DEG_LON = 111.32 * Math.cos((38 * Math.PI) / 180);

function detection(lon: number, lat: number, t: number): Detection {
  return { lon, lat, t, frp: 10, cellX: Math.floor(lon / CELL_SIZE_DEG), cellY: Math.floor(lat / CELL_SIZE_DEG) };
}

/** A fire front of three pixels moving east at `speedKmh`, observed every 12 h. */
function movingFire(speedKmh: number, epochs: number): Detection[] {
  const start = Date.UTC(2026, 7, 1, 1, 30);
  return Array.from({ length: epochs }, (_, i) => {
    const lon = 23 + (speedKmh * 12 * i) / KM_PER_DEG_LON;
    const t = start + i * 12 * 3_600_000;
    return [detection(lon, 38.0, t), detection(lon, 38.004, t + 50 * 60_000), detection(lon, 38.008, t)];
  }).flat();
}

test('clustering separates distant fires and merges adjacent cells', () => {
  const clusters = clusterDetections([
    detection(23.0, 38.0, 0),
    detection(23.015, 38.0, 0), // one cell gap → same fire
    detection(25.0, 39.0, 0),
  ]);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((c) => c.activeCells).sort(), [1, 2]);
});

test('predictor recovers speed and direction of a steadily moving fire', () => {
  const [cluster] = clusterDetections(movingFire(0.2, 4), 3);
  const forecast = new CentroidDriftPredictor().predict(cluster, [6, 24]);

  assert.equal(forecast.observedTrack.length, 4);
  assert.ok(Math.abs(forecast.speedKmh - 0.2) < 0.02, `speed ${forecast.speedKmh}`);
  assert.equal(forecast.bearingDeg, 90);
  assert.equal(forecast.confidence, 'high');

  const last = forecast.observedTrack.at(-1)!;
  const movedKm = (forecast.steps[1].center[0] - last.center[0]) * KM_PER_DEG_LON;
  assert.ok(Math.abs(movedKm - 0.2 * 24) < 0.3, `moved ${movedKm} km in 24 h`);
  assert.ok(forecast.steps[1].radiusKm > forecast.steps[0].radiusKm, 'uncertainty grows with the horizon');
});

test('a fire seen once is forecast as stationary with low confidence', () => {
  const [cluster] = clusterDetections(movingFire(0, 1));
  const forecast = new CentroidDriftPredictor().predict(cluster, [12]);
  assert.equal(forecast.speedKmh, 0);
  assert.equal(forecast.bearingDeg, null);
  assert.equal(forecast.confidence, 'low');
});
