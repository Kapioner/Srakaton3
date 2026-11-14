# Burning Activity Calendar

Harmonized burning activity calendar built from NASA FIRMS active fire hotspots (MODIS + VIIRS).
NASA Space Apps Challenge 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots".

## Quick start

Requires Node.js 20.12 or newer.

```bash
npm install
npm run etl:all
npm run dev
```

Open http://localhost:5173. The API runs on http://localhost:3001 (`/api/health` checks DuckDB and the ETL output).

## Repository layout

| Path | What it is |
|---|---|
| `sample_data/` | Raw FIRMS CSVs for Greece, 2000-2025 (`<sensor>/<sensor>_<year>_<Country>.csv`) |
| `etl/` | TypeScript + DuckDB pipeline: normalize, harmonize, report |
| `server/` | Fastify API over DuckDB (`server/fixtures/` holds sample responses) |
| `web/` | React + Vite frontend (MapLibre, ECharts) |
| `shared/api.ts` | API contract: response types used by both server and web |
| `docs/PLAN.md` | Implementation plan |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API (port 3001) and the frontend (port 5173) |
| `npm run etl:all` | Runs normalize, harmonize and report over the configured scope |
| `npm run etl:normalize` | Raw CSVs to `data/parquet/hotspots/year=/country=/` |
| `npm run etl:harmonize` | Calibration (`data/parquet/calibration/`) and harmonized daily grid (`data/parquet/harmonized/`) |
| `npm run etl:report` | Before/after HTML report in `data/reports/` |
| `npm run etl:download -- --country Poland` | Downloads FIRMS per-country CSVs into `sample_data/` |
| `npm run etl:download-world -- --dry-run` | Lists the yearly all-countries archives (world scale) |
| `npm run fixtures -w server` | Regenerates `server/fixtures/` from the ETL output |
| `npm run typecheck` | Type-checks all three packages |
| `npm run build` then `npm start` | Builds the frontend and serves it from the API process |

Configuration: copy `.env.example` to `.env`; the ETL and the API both read it. The data scope (`DATA_COUNTRIES`, `DATA_YEARS`) is configuration, so the same code runs on one country or the whole world. ETL flags (`--countries`, `--years`, `--input`, `--output`, `--force`, `--recalibrate`) override it.

## Harmonization

FRP-stratified, multi-satellite calibration to an Aqua-equivalent fire cell-day. Every satellite's detections are counted as fire cell-days on a 0.02 deg grid, split into five fire-size classes by FRP, and scaled by a per-satellite, per-class factor fitted against MODIS Aqua over their common period. The harmonized value `h` is stored per 0.1 deg cell and day, together with MODIS-only and VIIRS-only estimates. On Greece 2012-2025 these two independent estimates agree within about 6 % per year. Details: `etl/src/harmonization.ts`.

## Data

NASA FIRMS active fire archive, per-country yearly CSVs: MODIS Collection 6.1 (Terra, Aqua) and VIIRS 375 m (Suomi NPP, NOAA-20).
https://firms.modaps.eosdis.nasa.gov/country/
