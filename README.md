# server — live (near-real-time) fire feature

Fastify + DuckDB backend that keeps pulling NASA FIRMS active-fire files and serves them together with
the ETL archive: the current situation, a report for the selected area and a short-term movement
forecast. It does **not** harmonize anything; that is the ETL's job (`etl/src/harmonization.ts`).

## Run

```bash
npm install
npm run dev        # http://localhost:3001
npm test           # local fake FIRMS; the archive test also runs the real ETL normalize SQL
```

The server looks for the ETL in this order: `ETL_DIR`, then an `etl/` folder next to the server or in
any parent folder (monorepo layout `<repo>/server` + `<repo>/etl`). From the ETL it reads the
harmonization parameters (`etl/src/harmonization.ts`) and, in tests, the normalize SQL. Run
`npm install` inside the ETL too. Without an ETL the server still starts: it logs a warning, uses the
default grid (0.02°) and the archive test is skipped.

Relative data paths resolve against the repo root (the ETL's parent folder), as in the ETL itself;
without an ETL, against the server folder. Env (see `.env.example`): `ETL_DIR`, `ARCHIVE_DIR`
(default `data/parquet`, i.e. the ETL's `OUTPUT_DIR`), `LIVE_DB_PATH` (default
`data/live/live.duckdb`), `REPO_ROOT`, `LIVE_POLLING`, `LIVE_RETENTION_DAYS`, `LIVE_PAUSE_RESUME_MINUTES`.

## Data model: archive + live

| | Archive | Live |
|---|---|---|
| Source | FIRMS yearly per-country files | FIRMS NRT files (24h/48h/7d, per region) |
| Written by | `etl` (`npm run normalize`) | this server, every 30 s |
| Stored in | `<ARCHIVE_DIR>/hotspots/year=/country=/*.parquet` | `live_hotspots` in `LIVE_DB_PATH` |
| Schema | `etl/src/sql.ts` | **the same columns and types** |
| `type`, `country` | filled | `NULL` (NRT files carry neither) |

The server reads both through one DuckDB view, `hotspots_all`, which adds `origin`
(`archive` | `live`) and `ingested_at` (live only). Overlap rule: per satellite, the days the archive
holds come from the archive and live rows fill in the days after it. Live rows the archive covers
are not stored at all, and when the ETL adds a partition the server notices it (directory scan before
every ingest), rebuilds the views and deletes the superseded live rows. This assumes the archive's
country scope covers the live region (e.g. `DATA_COUNTRIES=*` with `region: Global`).

Live normalization (`src/live/repository.ts`) uses the ETL's mappings (satellite names `Terra | Aqua |
S-NPP | NOAA-20 | NOAA-21`, confidence classes, `acq_datetime`, `source`, `pixel_km2`).
`test/archive.test.ts` runs the real `copyToParquet` from `etl/src/sql.ts` and fails if the live
schema or values drift from it.

What this means for harmonization: `etl:harmonize` keeps working on the archive only. Live rows
have no `type` and no `country`, which its calibration needs, so the harmonized calendar ends where
the archive ends. Vegetation filtering (`type = 0`) applies to archive rows; live rows are kept.

## API (`/api/live`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/mode` | Current mode: `{ mode, acquiring, since, resumeAt }` |
| PUT | `/mode` | `{ "mode": "realtime" \| "archive" \| "forecast", "resumeAfterMinutes"?: n \| null }` |
| GET | `/scope/options` | Allowed regions, sensors and windows (for the frontend form) |
| GET | `/scope` | Current ingest scope |
| PUT | `/scope` | Set scope, then refresh in the background (202) |
| POST | `/ingest` | Run an ingest now and return its result (409 when paused) |
| GET | `/status` | Mode, running flag, scope, last run, live stats, archive (partitions, coverage per satellite) |
| GET | `/hotspots` | Archive + live hotspots: `bbox`, `from`, `to`, `hours` (default 24, used without `from`), `since`, `minConfidence`, `vegetationOnly` (default true), `limit`, `format=json\|geojson\|csv` (CSV is streamed) |
| GET | `/events` | Server-Sent Events: `hello`, `ingest` after every run, `mode` after every mode change |
| GET | `/report` | Summary for the selected area: `bbox`, `hours` (default 24) |
| GET | `/situation` | Current fires as GeoJSON polygons: `bbox`, `hours` (default 24), `limit` |
| GET | `/forecast` | Movement forecast as GeoJSON: `bbox`, `lookbackHours` (48), `horizons` (`6,12,24`), `limit` |

`bbox` is always `west,south,east,north`. Every hotspot carries `sensor`, `satellite`, `confidence`,
`frp`, `daynight`, `type`, `country` and `origin`.

Scope body (also the default: the whole world, every 30 seconds):

```json
{
  "region": "Global",
  "sensors": ["MODIS", "VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"],
  "window": "24h",
  "bbox": null,
  "pollIntervalSeconds": 30
}
```

`bbox` (optional) narrows the FIRMS region file; `pollIntervalSeconds` (10–86400) counts from the end
of one run to the start of the next, so slow downloads never overlap.

### Modes

| Mode | FIRMS acquisition | Use |
|---|---|---|
| `realtime` (default at start) | on | live map |
| `archive` | paused | user picked a date in the calendar |
| `forecast` | paused | user works with the forecast; the data under it stays fixed |

The frontend sends `PUT /mode` when the user switches views. Switching back to `realtime` fetches
immediately. A pause ends on its own after `resumeAfterMinutes` (default `LIVE_PAUSE_RESUME_MINUTES`
= 60; `null` = never), so a closed tab cannot stop acquisition for good. Re-sending the mode renews it.
While paused, `POST /ingest` returns 409 and a scope change is stored but fetched only on resume.
The mode is global for the server: one client pausing pauses it for everyone.

### Report

`GET /report?bbox=w,s,e,n&hours=24` reads `hotspots_all` (vegetation fires) for the area chosen in the
frontend (or the ingest scope's bbox, or everything) and returns: totals (raw detections, `fireCells`
= distinct cells of the ETL's fine grid `HARMONIZATION.fineGridDeg`, FRP), splits by confidence,
satellite and origin, an hourly timeline with empty hours filled in, the 10 most active ~0.5° areas,
and the acquisition state. These are not harmonized counts. Reload it on every `ingest` event.

### Live map updates

Every `/hotspots` response carries a `cursor` (time of the newest stored row). Passing it back as
`since` returns only rows stored after it. `/events` tells the client when to ask:

```ts
const source = map.getSource('hotspots') as maplibregl.GeoJSONSource;
const fc = await (await fetch(`${API}/api/live/hotspots?format=geojson`)).json();
let { cursor } = fc.metadata;
source.setData(fc);

new EventSource(`${API}/api/live/events`).addEventListener('ingest', async (e) => {
  if (JSON.parse(e.data).inserted === 0) return;
  const delta = await (await fetch(`${API}/api/live/hotspots?format=geojson&since=${cursor}`)).json();
  fc.features.push(...delta.features);
  cursor = delta.metadata.cursor;
  source.setData(fc);
});
```

`since` returns live rows only. Live rows disappear when the archive takes their day over or after
`LIVE_RETENTION_DAYS`, and a scope change replaces what is ingested, so the client should drop
features older than its time window (`properties.acq_datetime`) or reload the full collection from
time to time (e.g. after `PUT /scope`).

## Forecast method (`centroid-drift-v1`)

1. Cluster active cells into fires (cells at most 2 cells apart belong together).
2. Group each fire's detections into observation epochs (overpasses less than 90 min apart).
3. Fit a weighted line through the epoch centroids → velocity; through their spread → growth rate.
4. Project the last observed position forward; the radius widens by growth + 0.2 km/h of uncertainty.

Output per fire: a `track` LineString (observed + predicted positions) and one `forecast_area`
polygon per horizon, with `speedKmh`, `bearingDeg`, `growthKmh` and `confidence`.

Limits, stated plainly: this is a trend extrapolation of satellite detections. It has no wind, fuel
or terrain input, sees a fire only a few times a day, and apparent speed is capped at 3 km/h.
A wind-aware model can replace it by implementing `SpreadPredictor`.

## Structure

```
src/
  index.ts, app.ts, config.ts      bootstrap, composition root, ETL discovery
  etl.ts                           reads harmonization parameters from the ETL at runtime
  db/
    database.ts, schema.ts         DuckDB wrapper; live table = ETL hotspot schema
    catalog.ts                     archive (ETL Parquet) + live → view hotspots_all
  live/
    domain.ts                      types, scope, modes
    firms/source.ts                HotspotSource strategy + keyless FIRMS implementation
    repository.ts                  NRT → ETL schema, queries over hotspots_all, scope, run log
    ingestService.ts, scheduler.ts ingest orchestration, polling loop
    modeController.ts              realtime / archive / forecast: starts and pauses polling
    reportService.ts               area report (SQL aggregates)
    forecast/                      clustering, predictor strategy, GeoJSON service
    routes.ts                      Fastify plugin
```
