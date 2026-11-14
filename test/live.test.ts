import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { Database } from '../src/db/database.js';
import { acqDate, acqTime, startFakeFirms } from './helpers.js';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

// VIIRS: a fire near Athens seen on three overpasses, drifting east. Confidence as words (NRT style).
const viirsRows = [30, 18, 6].flatMap((h, i) => {
  const d = hoursAgo(h);
  const lon = (23.5 + i * 0.015).toFixed(5);
  return [
    `38.10000,${lon},330.1,0.39,0.36,${acqDate(d)},${acqTime(d)},N,nominal,2.0NRT,290.5,12.5,D`,
    `38.10400,${lon},345.0,0.39,0.36,${acqDate(d)},${acqTime(d)},N,high,2.0NRT,291.0,30.0,D`,
  ];
});
const VIIRS_CSV = ['latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight', ...viirsRows].join('\n') + '\n';

// MODIS: numeric confidence, one detection per class, one of them outside Europe's Greek bbox.
const m = hoursAgo(5);
const MODIS_CSV = [
  'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight',
  `38.102,23.541,320.5,1.0,1.0,${acqDate(m)},${acqTime(m)},T,25,6.1NRT,295.0,15.0,D`,
  `38.106,23.543,325.5,1.0,1.0,${acqDate(m)},${acqTime(m)},A,55,6.1NRT,296.0,22.0,D`,
  `52.200,21.000,340.0,1.0,1.0,${acqDate(m)},${acqTime(m)},A,95,6.1NRT,297.0,40.0,D`,
].join('\n') + '\n';

test('live feature: scope → ingest → query → situation → forecast', async (t) => {
  const firms = await startFakeFirms({
    '/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_48h.csv': VIIRS_CSV,
    '/modis-c6.1/csv/MODIS_C6_1_Europe_48h.csv': MODIS_CSV,
  });
  const db = await Database.open(':memory:');
  const app = await buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      liveDbPath: ':memory:',
      firmsBaseUrl: firms.baseUrl,
      pollingEnabled: false,
      retentionDays: 14,
      tmpDir: path.join(os.tmpdir(), `firewatch-test-${process.pid}`),
    },
    db,
    { logger: false },
  );
  t.after(async () => {
    await app.close();
    db.close();
    firms.close();
  });

  await t.test('rejects an invalid scope', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/live/scope', payload: { region: 'Mars', sensors: ['MODIS'], window: '24h' } });
    assert.equal(res.statusCode, 400);
  });

  await t.test('stores the scope chosen by the frontend', async () => {
    const scope = { region: 'Europe', sensors: ['MODIS', 'VIIRS_SNPP', 'VIIRS_NOAA20'], window: '48h', bbox: [19, 34, 29, 42] };
    const res = await app.inject({ method: 'PUT', url: '/api/live/scope', payload: scope });
    assert.equal(res.statusCode, 202);
    const saved = (await app.inject('/api/live/scope')).json();
    assert.deepEqual(saved.bbox, [19, 34, 29, 42]);
    assert.equal(saved.window, '48h');
  });

  await t.test('ingests, harmonizes and isolates a failing sensor', async () => {
    const run = (await app.inject({ method: 'POST', url: '/api/live/ingest' })).json();
    // NOAA-20 file is missing on the fake server → partial, the rest still lands.
    assert.equal(run.status, 'partial');
    assert.equal(run.inserted, 8); // 6 VIIRS + 2 MODIS inside the bbox (Warsaw row filtered out)
    assert.ok(firms.requests.every((url) => url.endsWith('_Europe_48h.csv')));
  });

  await t.test('re-ingesting is idempotent (conditional GET + primary key)', async () => {
    const run = (await app.inject({ method: 'POST', url: '/api/live/ingest' })).json();
    assert.equal(run.inserted, 0);
    const statuses = run.details.outcomes.map((o: any) => o.status);
    assert.deepEqual(statuses, ['unchanged', 'unchanged', 'failed']);
    const status = (await app.inject('/api/live/status')).json();
    assert.equal(status.store.hotspots, 8);
  });

  await t.test('serves hotspots on a common confidence scale', async () => {
    const body = (await app.inject('/api/live/hotspots?bbox=19,34,29,42')).json();
    assert.equal(body.count, 8);
    const modis = body.hotspots.filter((h: any) => h.instrument === 'MODIS');
    assert.deepEqual(modis.map((h: any) => `${h.satellite}:${h.confidence}`).sort(), ['Aqua:nominal', 'Terra:low']);
    assert.ok(body.hotspots.every((h: any) => ['low', 'nominal', 'high'].includes(h.confidence)));

    const high = (await app.inject('/api/live/hotspots?minConfidence=high')).json();
    assert.equal(high.count, 3);
  });

  await t.test('streams a CSV export', async () => {
    const res = await app.inject('/api/live/hotspots?format=csv');
    assert.match(res.headers['content-disposition'] as string, /attachment/);
    const lines = res.body.trim().split('\n');
    assert.equal(lines[0], 'latitude,longitude,acq_datetime,instrument,satellite,confidence,frp,daynight');
    assert.equal(lines.length, 9);
  });

  await t.test('describes the current situation as one sensor-independent fire', async () => {
    const body = (await app.inject('/api/live/situation?hours=48')).json();
    assert.equal(body.features.length, 1);
    const fire = body.features[0];
    assert.equal(fire.geometry.type, 'Polygon');
    assert.equal(fire.properties.detections, 8);
    assert.equal(fire.properties.active, true);
  });

  await t.test('forecasts eastward movement', async () => {
    const body = (await app.inject('/api/live/forecast?horizons=6,12')).json();
    const track = body.features.find((f: any) => f.properties.kind === 'track');
    const areas = body.features.filter((f: any) => f.properties.kind === 'forecast_area');
    assert.equal(areas.length, 2);
    assert.ok(track.properties.bearingDeg > 60 && track.properties.bearingDeg < 120, `bearing ${track.properties.bearingDeg}`);
    assert.ok(track.properties.speedKmh > 0);
    assert.ok(areas[1].properties.center[0] > areas[0].properties.center[0]);
  });

  await t.test('rejects a malformed bbox', async () => {
    assert.equal((await app.inject('/api/live/situation?bbox=1,2,3')).statusCode, 400);
  });
});
