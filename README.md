# server — live (near-real-time) fire feature

Fastify + DuckDB backend that keeps pulling NASA FIRMS active-fire files, harmonizes MODIS and VIIRS
detections into one table, and serves the current situation plus a short-term movement forecast.
It is a separate feature that sits next to the archive/calendar API: own route prefix (`/api/live`),
own tables (`live_*`), same `Database` instance.

## Run

```bash
npm install
cp .env.example .env      # optional, defaults work
npm run dev               # http://localhost:3001
npm test                  # runs against a local fake FIRMS server, no network needed
```

## Data source

Keyless FIRMS files listed on <https://firms.modaps.eosdis.nasa.gov/active_fire/>:

```
{FIRMS_BASE_URL}/{sensor-dir}/csv/{PREFIX}_{Region}_{24h|48h|7d}.csv
e.g. .../noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv
```

Sensors: MODIS (Terra+Aqua), VIIRS S-NPP, VIIRS NOAA-20, VIIRS NOAA-21. Downloads use conditional
GETs (ETag / Last-Modified), so an unchanged file costs one 304.

## API (`/api/live`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/scope/options` | Allowed regions, sensors and windows (for the frontend form) |
| GET | `/scope` | Current ingest scope |
| PUT | `/scope` | Set scope, then refresh in the background (202) |
| POST | `/ingest` | Run an ingest now and return its result |
| GET | `/status` | Running flag, scope, last run (per-sensor outcome), store stats |
| GET | `/hotspots` | Harmonized hotspots: `bbox`, `from`, `to`, `minConfidence`, `limit`, `format=json\|csv` (CSV is streamed) |
| GET | `/situation` | Current fires as GeoJSON polygons: `bbox`, `hours` (default 24), `limit` |
| GET | `/forecast` | Movement forecast as GeoJSON: `bbox`, `lookbackHours` (48), `horizons` (`6,12,24`), `limit` |

`bbox` is always `west,south,east,north`.

Scope body:

```json
{
  "region": "Europe",
  "sensors": ["MODIS", "VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"],
  "window": "24h",
  "bbox": [19, 34, 29, 42],
  "pollIntervalMinutes": 30
}
```

`bbox` (optional) narrows the FIRMS region file; `pollIntervalMinutes` is 5–1440.

## Harmonization

Done in one SQL statement for every sensor (`src/live/repository.ts`):

- confidence → `low | nominal | high` (MODIS 0–100: <30, 30–80, >80; VIIRS l/n/h),
- satellite codes → `Terra | Aqua | SNPP | NOAA20 | NOAA21`,
- `acq_date` + `acq_time` → one UTC timestamp,
- position → cell of a common 0.01° (~1 km) grid.

Situation and forecast work on **active grid cells**, not raw points, so a fire seen by three VIIRS
satellites is not "bigger" than one seen by MODIS only. Re-ingesting overlapping files is idempotent
(primary key on satellite + time + position). Rows older than `LIVE_RETENTION_DAYS` are purged;
long-term history is the archive's job.

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
  index.ts, app.ts, config.ts      bootstrap, composition root
  db/                              Database wrapper, schema
  live/
    domain.ts                      types, scope, grid constant
    firms/source.ts                HotspotSource strategy + keyless FIRMS implementation
    repository.ts                  all SQL (harmonize+insert, queries, scope, run log)
    ingestService.ts, scheduler.ts ingest orchestration, polling loop
    forecast/                      clustering, predictor strategy, GeoJSON service
    routes.ts                      Fastify plugin
```
