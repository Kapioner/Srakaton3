import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// The real ETL step 1, so the archive here is exactly what `npm run normalize` writes.
import { copyToParquet } from '../../etl/src/sql.ts';
import { buildApp } from '../src/app.js';
import { Database } from '../src/db/database.js';
import { HOTSPOT_COLUMNS } from '../src/db/schema.js';
import { acqDate, startFakeFirms } from './helpers.js';

const DAY = 86_400_000;
const day = (offset: number) => acqDate(new Date(Date.now() + offset * DAY));
const year = (offset: number) => Number(day(offset).slice(0, 4));

const ARCHIVE_VIIRS_HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type';
const NRT_VIIRS_HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';

/** Writes archive-format CSVs for one sensor/year/country and runs the ETL normalize SQL on them. */
async function etlNormalize(db: Database, archiveDir: string, rawDir: string, name: string, rows: string[]) {
  const [source, y, country] = name.split('_');
  const file = path.join(rawDir, `${name}.csv`);
  fs.writeFileSync(file, [ARCHIVE_VIIRS_HEADER, ...rows].join('\n') + '\n');
  const staging = path.join(archiveDir, '.staging', name);
  fs.mkdirSync(path.dirname(staging), { recursive: true }); // normalize.ts creates its staging root too
  await db.run(copyToParquet([{ path: file, source, year: Number(y), country } as any], staging));
  // Same swap-into-place step as etl/src/normalize.ts.
  const target = path.join(archiveDir, 'hotspots', `year=${y}`, `country=${country}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(staging, `year=${y}`, `country=${country}`), target);
  fs.rmSync(path.join(archiveDir, '.staging'), { recursive: true, force: true });
}

test('archive (ETL Parquet) and live data are read as one dataset', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firewatch-archive-'));
  const archiveDir = path.join(root, 'parquet');
  const rawDir = path.join(root, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  // Archive (ETL): S-NPP up to 3 days ago, with one static industrial source (type 2).
  const etlDb = await Database.open(':memory:');
  await etlNormalize(etlDb, archiveDir, rawDir, `viirs-snpp_${year(-3)}_Greece`, [
    `38.10000,23.50000,330.1,0.39,0.36,${day(-4)},1112,N,VIIRS,n,2,290.5,12.5,D,0`,
    `38.10000,23.51000,331.1,0.39,0.36,${day(-3)},1112,N,VIIRS,h,2,290.5,20.0,D,0`,
    `37.95000,23.62000,350.0,0.39,0.36,${day(-3)},1112,N,VIIRS,h,2,295.0,80.0,D,2`,
  ]);

  // Live (FIRMS NRT 7d file): one day the archive already covers, two newer days.
  const nrt = [
    NRT_VIIRS_HEADER,
    `38.10010,23.51010,331.0,0.39,0.36,${day(-3)},1112,N,h,2.0NRT,290.5,19.0,D`,
    `38.11000,23.52000,332.0,0.39,0.36,${day(-2)},112,N,n,2.0NRT,290.5,14.0,N`,
    `38.12000,23.53000,333.0,0.39,0.36,${day(-1)},1030,N,l,2.0NRT,290.5,9.0,D`,
  ].join('\n') + '\n';
  const firms = await startFakeFirms({ '/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_7d.csv': nrt });

  const db = await Database.open(':memory:');
  const app = await buildApp(
    {
      port: 0,
      host: '127.0.0.1',
      liveDbPath: ':memory:',
      archiveDir,
      firmsBaseUrl: firms.baseUrl,
      pollingEnabled: false,
      retentionDays: 30,
      pauseResumeMinutes: 60,
      tmpDir: path.join(root, 'tmp'),
    },
    db,
    { logger: false },
  );
  t.after(async () => {
    await app.close();
    db.close();
    etlDb.close();
    firms.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('live rows have exactly the ETL schema', async () => {
    const archive = await db.all(`DESCRIBE SELECT * FROM read_parquet('${archiveDir}/hotspots/**/*.parquet', hive_partitioning = true)`);
    const archiveTypes = new Map(archive.map((c) => [c.column_name, c.column_type]));
    assert.deepEqual([...archiveTypes.keys()].sort(), HOTSPOT_COLUMNS.map(([n]) => n).sort());
    for (const [name, type] of HOTSPOT_COLUMNS) {
      // Hive partition keys are typed by DuckDB on read (year → BIGINT); the view casts them.
      if (name !== 'year') assert.equal(archiveTypes.get(name), type, name);
    }
    const live = await db.all(`DESCRIBE live_hotspots`);
    assert.deepEqual(
      live.map((c) => `${c.column_name}:${c.column_type}`).filter((c) => !c.startsWith('ingested_at')),
      HOTSPOT_COLUMNS.map(([n, ty]) => `${n}:${ty}`),
    );
  });

  await t.test('ingest normalizes NRT rows the same way the ETL does', async () => {
    await app.inject({ method: 'PUT', url: '/api/live/scope', payload: { region: 'Global', sensors: ['VIIRS_SNPP'], window: '7d' } });
    const run = (await app.inject({ method: 'POST', url: '/api/live/ingest' })).json();
    assert.equal(run.status, 'ok');
    assert.equal(run.inserted, 2, 'the row of a day the archive covers is dropped at once');

    const [liveRow] = await db.all(`SELECT * FROM live_hotspots WHERE acq_date = CAST('${day(-2)}' AS DATE)`);
    assert.equal(liveRow.satellite, 'S-NPP');
    assert.equal(liveRow.sensor, 'VIIRS');
    assert.equal(liveRow.source, 'viirs-snpp');
    assert.equal(liveRow.confidence, 'nominal');
    assert.equal(liveRow.confidence_raw, 'n');
    assert.equal(liveRow.acq_time, '0112');
    assert.equal(liveRow.pixel_km2, 0.1404);
    assert.equal(liveRow.type, null);
    assert.equal(liveRow.country, null);

    const [archiveRow] = await db.all(`SELECT * FROM archive_hotspots WHERE acq_date = CAST('${day(-4)}' AS DATE)`);
    for (const column of ['sensor', 'satellite', 'source', 'confidence', 'daynight', 'acq_time', 'pixel_km2', 'scan', 'track']) {
      assert.equal(typeof liveRow[column], typeof archiveRow[column], column);
    }
  });

  await t.test('one query spans archive and live; archive wins on days it covers', async () => {
    const body = (await app.inject('/api/live/hotspots?hours=168&bbox=23,37,24,39')).json();
    const byDay = body.hotspots.map((h: any) => `${h.acq_datetime.slice(0, 10)}:${h.origin}`).sort();
    assert.deepEqual(byDay, [`${day(-4)}:archive`, `${day(-3)}:archive`, `${day(-2)}:live`, `${day(-1)}:live`]);
    assert.ok(body.hotspots.every((h: any) => h.type === 0 || h.type === null), 'static source filtered');

    const all = (await app.inject('/api/live/hotspots?hours=168&vegetationOnly=false')).json();
    assert.equal(all.count, 5);
    assert.ok(all.hotspots.some((h: any) => h.type === 2));
  });

  await t.test('status and report describe both sources', async () => {
    const status = (await app.inject('/api/live/status')).json();
    assert.equal(status.archive.available, true);
    assert.deepEqual(status.archive.coverage, [{ satellite: 'S-NPP', lastDate: day(-3) }]);
    assert.equal(status.live.liveHotspots, 2);

    const report = (await app.inject('/api/live/report?hours=168')).json();
    assert.equal(report.totals.detections, 4);
    assert.deepEqual(report.byOrigin, [{ origin: 'archive', detections: 2 }, { origin: 'live', detections: 2 }]);
    assert.equal(report.units.fireCellDeg, 0.02);
  });

  await t.test('when the ETL archives newer days, they replace the live rows', async () => {
    await etlNormalize(etlDb, archiveDir, rawDir, `viirs-snpp_${year(-2)}_Greece`, [
      `38.11000,23.52000,332.0,0.39,0.36,${day(-2)},0112,N,VIIRS,n,2,290.5,14.0,N,0`,
    ]);
    // Same year as the first file → the ETL rewrites that partition; keep the older rows too.
    if (year(-2) === year(-3)) {
      await etlNormalize(etlDb, archiveDir, rawDir, `viirs-snpp_${year(-3)}_Greece`, [
        `38.10000,23.50000,330.1,0.39,0.36,${day(-4)},1112,N,VIIRS,n,2,290.5,12.5,D,0`,
        `38.10000,23.51000,331.1,0.39,0.36,${day(-3)},1112,N,VIIRS,h,2,290.5,20.0,D,0`,
        `37.95000,23.62000,350.0,0.39,0.36,${day(-3)},1112,N,VIIRS,h,2,295.0,80.0,D,2`,
        `38.11000,23.52000,332.0,0.39,0.36,${day(-2)},0112,N,VIIRS,n,2,290.5,14.0,N,0`,
      ]);
    }
    await app.inject({ method: 'POST', url: '/api/live/ingest' }); // refreshes the catalog and purges

    const body = (await app.inject('/api/live/hotspots?hours=168&bbox=23,37,24,39')).json();
    const byDay = body.hotspots.map((h: any) => `${h.acq_datetime.slice(0, 10)}:${h.origin}`).sort();
    assert.deepEqual(byDay, [`${day(-4)}:archive`, `${day(-3)}:archive`, `${day(-2)}:archive`, `${day(-1)}:live`]);
    const [{ n }] = await db.all(`SELECT count(*)::INTEGER AS n FROM live_hotspots`);
    assert.equal(n, 1, 'superseded live rows are purged');
  });
});
