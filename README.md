# Burning Activity Calendar

Harmonized burning activity calendar built from NASA FIRMS active fire hotspots (MODIS + VIIRS).
NASA Space Apps Challenge 2026, challenge "Harmonization of MODIS and VIIRS Hot Spots".

## Quick start

Requires Node.js 20.12 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The API runs on http://localhost:3001 (`/api/health` checks DuckDB).

## Repository layout

| Path | What it is |
|---|---|
| `sample_data/` | Raw FIRMS CSVs for Greece, 2000-2025 (`<sensor>/<sensor>_<year>_<Country>.csv`) |
| `etl/` | TypeScript + DuckDB pipeline: raw CSV to harmonized Parquet and calibration |
| `server/` | Fastify API over DuckDB (`server/fixtures/` holds sample responses) |
| `web/` | React + Vite frontend (MapLibre, ECharts) |
| `shared/api.ts` | API contract: response types used by both server and web |
| `shared/config.ts` | Runtime configuration read from the environment or `.env` |
| `docs/PLAN.md` | Implementation plan and harmonization method |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API (port 3001) and the frontend (port 5173) |
| `npm run etl` | Runs the ETL pipeline over `DATA_DIR` |
| `npm run download -- --country Poland` | Downloads FIRMS per-country CSVs into `sample_data/` |
| `npm run typecheck` | Type-checks all three packages |
| `npm run build` then `npm start` | Builds the frontend and serves it from the API process |

Configuration: copy `.env.example` to `.env`. The data scope (`DATA_COUNTRIES`, `DATA_YEARS`) is configuration, so the same code runs on one country or the whole world.

## Data

NASA FIRMS active fire archive, per-country yearly CSVs: MODIS Collection 6.1 (Terra, Aqua) and VIIRS 375 m (Suomi NPP, NOAA-20).
https://firms.modaps.eosdis.nasa.gov/country/
