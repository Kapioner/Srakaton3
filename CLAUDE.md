# Project context: Harmonized Burning Activity Calendar

This repository is a hackathon project (NASA Space Apps 2026, Stalowa Wola). Treat the challenge below as the main context and goal for all work here. The user talks in Polish; reply in Polish.

## Challenge (original text)

Your challenge is to develop a harmonized burning activity calendar based on active fire hotspots in a web application, combining the extensive historical series of MODIS with the continuity and greater detail of VIIRS to provide a consistent time series of hotspot activity.

This challenge could be approached in two parts. The first is MODIS and VIIRS hotspot harmonization, so that by the end of that phase the sensor of origin no longer matters and the patterns, trends, and anomalies become the focus.

The second involves developing a web application that takes harmonized hotspot data as input. Through this visual tool, a user could select a region and a specific date range, then download analytics and visualizations of fire activity.

A calendar of burning activity showing the number of hotspots detected from the early 2000s to the present, built on the harmonized hotspots dataset and integrated into the web application, would give emergency managers a view of the fire history of an area: which periods of the year see more fires, which years had more burning activity, and how a current fire compares with previous ones.

In addition to numerical information, you could consider how color ramps might represent similarities and differences in the number of detected hotspots across months, providing an accessible and intuitive way to visualize fire activity. A downloadable CSV File of hot spots detected during a search would be another useful output.

## Key requirements (summary)

1. **Harmonization (part 1):** combine MODIS (from ~2000, 1 km) and VIIRS (from 2012, 375 m) active-fire hotspots into one consistent time series where the source sensor no longer matters.
2. **Web app (part 2):** takes the harmonized data as input; the user selects a region and a date range.
3. **Burning activity calendar:** hotspot counts from the early 2000s to the present (e.g. year × month grid), showing seasonal peaks, the most active years, and how the current period compares with history.
4. **Color ramps:** accessible, intuitive coloring of monthly hotspot counts.
5. **Outputs:** downloadable analytics/visualizations and a CSV of the hotspots found by a search.

Target users: emergency managers.

## Hackathon rules & judging (from the local event guide)

- Event: NASA Space Apps Challenge 2026, Stalowa Wola, **14–15 November 2026**. Our challenge: **"Harmonization of MODIS and VIIRS Hot Spots"** (technology category).
- **Submission deadline: Sunday 15 November 2026, 23:59 local time**, via the Space Apps portal. Everything on the submission page **in English** (a video may be in Polish only with English subtitles). No profanity.
- Submission fields: title, high-level summary, **public link to project files** (GitHub repo), **demo link** (max **7 slides** or max **30 s video**; judges stop after the limit), detailed description (what, how, tools), **Space Agency Data** (which NASA data and how; required for global judging), Hackathon Journey, References (all data, code, tools used).
- Local judging: **live pitch max 3 min + Q&A**, then judges read the submission; each criterion scored **1–5**:
  1. **Impact:** a real problem with broad reach and benefit.
  2. **Creativity:** an original or novel approach.
  3. **Validity:** scientifically sound, does what it claims, works in the real world.
  4. **Relevance:** answers this challenge, is complete, uses NASA data meaningfully.
  5. **Presentation:** clear story (challenge → solution → why it matters). The guide stresses that teams often neglect this one.
- Suggested 30 s demo story: who we are → which challenge and why → name + tagline → how it works (screenshots) → future vision.

## Implementation plan

The full plan (MVP scope, API contract, screen layout, phases, risks) is in [docs/PLAN.md](docs/PLAN.md). Follow it unless the user decides otherwise. The harmonization method is the one described below under "Chosen method" (it replaced the plan's original v1).

- Dev data: `sample_data/<sensor>/<sensor>_<year>_Greece.csv`. MODIS covers 2000–2025, VIIRS S-NPP 2012–2025, VIIRS NOAA-20 2018–2025. NOAA-21 is not available in the FIRMS per-country archive. Download more with `npm run etl:download -- --country <Name>`.
- ETL output goes to `data/parquet/` (git-ignored); the API server reads the same folder (`OUTPUT_DIR`). Both read `<repo>/.env` (see `.env.example`).
- API contract: `shared/api.ts` (types used by server and web). `server/fixtures/` holds sample responses generated from the ETL output with `npm run fixtures -w server`.
- Data source (`DATA_SOURCE`, default `auto`): the server queries the Parquet dataset in `OUTPUT_DIR` when it exists, otherwise it serves the fixtures and says why (`/api/health`). World scale = the same ETL layout in another folder: set `OUTPUT_DIR`, no code change.
- Server guard rails (so it does not crash a laptop): DuckDB memory cap (a third of RAM, 1-4 GB), thread cap, per-query timeout with interrupt (504), queue of max 3 concurrent queries, grid coarsening to `GRID_MAX_CELLS`, row caps on points and CSV export. All in `.env.example`.
- Server code: `server/src/config.ts` (env), `db.ts` (DuckDB + limits), `dataset.ts` (source detection, views, cached metadata), `queries.ts` (all archive queries), `routes/api.ts`.
- World data in the server (`.env`: `OUTPUT_DIR=data/parquet_global`, `DATA_SOURCE=parquet`, `DUCKDB_MEMORY_LIMIT=8GB`, `DUCKDB_THREADS=8`; note the ETL reads the same `.env`, so its defaults become the world dataset too): whole-month ranges in `calendar`, `series` and `grid` read the `harmonized_monthly` view when it exists; `summary` is one scan grouped by day and the same-period comparison is one scan keyed by month*100+day (the old range join timed out on world data); views are created once (concurrent first requests caused DuckDB "write-write conflict"); the whole-dataset `/api/report` is precomputed at boot. Measured on the world dataset (warm): calendar ~0.6–1 s, series ~1.3 s, summary world ~2 s / Greece ~0.4 s, grid world all years ~3 s / Greece ~0.3 s, report Greece ~5 s first then cached, export Greece one month ~3 s; first full page load ~9 s.
- Frontend query flow: the query panel applies region (country / map view / all) + dates on "Apply". Map and summary follow region + dates; calendar and sensor chart always show the region's whole history with the selected period outlined.
- The `origin/API_backend` branch (live FIRMS feed + forecast) is a separate restructured project and is NOT merged.
- Dev loop: `npm run etl:all` once, then `npm run dev` (API on 3001, web on 5173). The frontend lives in `web/` only.

## Tech stack (decided)

- **Monorepo:** `etl/`, `server/`, `web/`.
- **TypeScript** everywhere (pragmatic, non-strict is fine; backend run with `tsx`).
- **ETL (`etl/`):** TypeScript + DuckDB (`@duckdb/node-api`). Converts raw (already extracted) CSVs → harmonized Parquet + pre-aggregates.
- **Backend (`server/`):** Fastify + `@duckdb/node-api`. Read-only queries over Parquet; one DuckDB instance per process.
- **Frontend (`web/`):** React + Vite, **MapLibre GL** (via `react-map-gl`; basemap OpenFreeMap or Carto dark-matter; region drawing with `terra-draw`) and **Apache ECharts** (`echarts-for-react`).
- Optional later: deck.gl (hexagon/H3/3D layers), PostgreSQL + PostGIS for pre-aggregates/user data (DuckDB `postgres` extension can write there). Keep DB access behind a `db/queries` layer so the engine can be swapped.

## Architecture principles

- **Never ship raw data to the frontend.** Calendar/charts get aggregates (year × month ≈ 300 numbers, daily ≈ 9.5k). Map gets grid/H3 aggregates per zoom; raw points only at high zoom.
- **CSV export** of raw harmonized hotspots for a search is **streamed** from DuckDB to the HTTP response (`Content-Disposition: attachment`), gzip/brotli enabled.
- **Pre-aggregates:** `cell × date → count` (0.1° grid or H3) for fast calendar/map queries; raw points stay in Parquet for export.
- Queries always filter by **coordinates (bbox/polygon) and date**, never by country file name. Regions may cross borders.
- Charts exportable as PNG (ECharts `toolbox.saveAsImage`). Color ramps: colorblind-safe sequential (`YlOrRd` / `inferno` / `viridis`) plus an optional diverging anomaly-vs-long-term-mean view.

## Dataset

- Source: NASA FIRMS active-fire CSVs, one **ZIP per year containing all countries** (~400 MB for recent years, older years much smaller), extracted manually to `data/<sensor>/<year>/*.csv` before the ETL runs (the ETL reads CSVs only, no ZIP handling), ~25 years (2000 → present), ~6 GB total.
- Files per country and sensor, e.g. `viirs-jpss1_2025_Greece.csv`, `viirs-snpp_...`, `modis_...` (newer years also `viirs-jpss2_...`). The ETL detects the sensor from the file name and/or the `instrument`/`satellite` columns.
- VIIRS columns: `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type`. MODIS uses `brightness`/`bright_t31` and numeric `confidence` (0–100).

### Sensors and satellites

| Instrument | Satellite | Data from | `satellite` code | Pixel | Overpass (local) |
|---|---|---|---|---|---|
| MODIS | Terra | 2000 | Terra / T | 1 km | ~10:30 / 22:30 |
| MODIS | Aqua | 2002 | Aqua / A | 1 km | ~13:30 / 01:30 |
| VIIRS | Suomi NPP | 2012 | N | 375 m | ~13:30 / 01:30 |
| VIIRS | NOAA-20 (= JPSS-1) | 2018 | N20 | 375 m | ~13:30 / 01:30 |
| VIIRS | NOAA-21 (= JPSS-2) | 2023/24 | N21 | 375 m | ~13:30 / 01:30 |

### Development scope vs. full scale

- **Development region: Greece**, all years. Small (tens of MB), strong fire seasonality, big fire years (2007, 2021, 2023), includes static industrial sources to test filtering. Poland may be added as a second demo country.
- The solution **must stay ready for the whole world**. Data scope is config, not code, e.g. `DATA_COUNTRIES=Greece` (dev) vs `DATA_COUNTRIES=*`, `DATA_YEARS=2000-2025`.
- ETL is **incremental, year by year / country by country**, writing Parquet partitioned by `year=/country=`. Adding a year or country means adding a partition.
- For the demo, prove scalability by running 1–2 full global years (or everything) and reporting timings (ETL per year, global calendar query, CSV export).

## Harmonization rules (MODIS + VIIRS)

- Filter `type`: keep `0` (presumed vegetation fire); drop `2` (static land source / industrial) and other non-vegetation types.
- Map confidence to common classes: VIIRS `l/n/h` ↔ MODIS 0–100 (e.g. <30 low, 30–80 nominal, >80 high).
- Raw counts are **not comparable**: VIIRS (375 m) detects several times more than MODIS (1 km), and the number of satellites grows over time (2000 Terra → 2002 +Aqua → 2012 +S-NPP → 2018 +NOAA-20 → 2024 +NOAA-21). Summing raw points creates a fake upward trend.
- Approach: aggregate to a common grid (~1 km or H3) and count **active cells per day** (deduplicating detections across satellites), and/or calibrate a MODIS↔VIIRS ratio over the overlap period (2012 → present). The goal: after harmonization the sensor of origin no longer matters.

### Chosen method (implemented in `etl/src/harmonization.ts`)

**FRP-stratified, multi-satellite calibration to an Aqua-equivalent fire cell-day:**
1. Unit = fire cell-day: 0.02° cell with ≥1 type-0 detection by one satellite on one day (removes the pixel-size effect).
2. Each satellite's cell-day gets an FRP class by its summed FRP (<5, 5–10, 10–20, 20–40, ≥40 MW). The VIIRS/MODIS ratio depends on fire size (small fires are VIIRS-only), so a single constant factor under-estimates big-fire years by 20–40 %.
3. `k[satellite, class]` = cell-days(satellite) / cell-days(Aqua) over their overlap, **per country**, shrunk towards the global k (α = 50).
4. Combination per day: `h = Σ_class Σ_sat n / Σ_sat k` over satellites flying that day (Poisson MLE). Adding or losing a satellite changes noise, not level. `h_modis` / `h_viirs` = the same estimate from one sensor family only.

Evidence (Greece): one constant factor → 15 % yearly error, 2021/2023 under-estimated by 21–33 %. Stratified, fitted on 2012–2020 only → 2021/2023 predicted within 0–9 %. Final MODIS-only vs VIIRS-only agreement 2012–2025: ~6 % per year. A coarser grid (0.05–0.1°) did not help. Globally (2025) per-class k varies far less between countries than the overall ratio (2.9–6.9).

Evidence (whole world, 2000–2026, 600 M detections, `npm run etl:validate --oos`): MODIS-only vs VIIRS-only yearly agreement 2.9 %; top-30 countries each within 10 % (country-year 5 %); raw jumps ×5.3 at 2012 and ×1.5 at 2018 vanish in `h` (1.02× / 0.94×, same as MODIS-only). **Out-of-sample** (k fitted on 2012–2018 only, tested 2019+): yearly 4.5 % (2019–2024 within ±4 %, 2025 +9.5 %, 2026 +17.5 %), country-year 11.6 %.

Known limits: the MODIS reference itself drifts at the end of the mission (Terra's orbit since ~2020: Terra/Aqua ratio 0.49 → 0.42; Aqua left the A-Train), which explains the larger 2025–2026 out-of-sample error; a time-windowed k is the next improvement. NOAA-21 exists only in 2026 and is calibrated against the already drifting Aqua (its k differs from S-NPP/NOAA-20); calibrating it against NOAA-20 (same orbit) would be more robust. After Aqua ends, new satellites need chained calibration; not implemented yet. A satellite without calibration is excluded from `h` (it would otherwise inflate it).

## Data status (local, `data/` is gitignored)

- `data/<sensor>/<year>/`: per-country CSVs 2000–2025 for the whole world (~41 GB), downloaded with `etl:download-world`.
- `data/modis/2026/`: global FIRMS "Archive Download" export for 2026 (`fire_archive_*` until Jul/Aug + `fire_nrt_*` until 2026-11-14; all 4 satellites incl. NOAA-21; no country column, NRT has no `type`), imported with `etl:import-global`.
- `data/parquet/`: Greece dev dataset. `data/parquet_global/`: whole world 2000–2026 (hotspots ~10 GB, harmonized 728 MB, harmonized_monthly 319 MB).
- World timings: normalize ~27 min (2000–2025), import 2026 ~7 min, harmonize ~19 min (calibration 6 min), validate --oos ~26 min. Query speed (world data): calendar year × month ~0.4 s from `harmonized_monthly` in a fresh process, Greece daily ~0.4 s, Europe map grid 0.16 s, CSV export Greece 2021–2023 ~4.7 s (streams, so the first byte is immediate).
- Long jobs should run in the user's own terminal so progress is visible; the user makes git commits personally.

## ETL commands

- `npm run etl:download-world`: FIRMS yearly "all countries" ZIPs (45 files, ~8.6 GB), one at a time with pauses/back-off, extracted to `data/<sensor>/<year>/` with a `.complete.json` marker. `--dry-run`, `--refresh`, `--from/--to`, `--sensors`.
- `npm run etl:normalize`: raw CSV → `<out>/hotspots/year=/country=/` (common schema, nothing dropped, incremental per year × country).
- `npm run etl:import-global`: FIRMS global `fire_archive_*` / `fire_nrt_*` CSVs → same schema; country from historical 0.1°/1° cells (0.3 % 'Unknown'), NRT `type` inferred from historical non-vegetation 0.01° cells (98 % accurate on archive rows); replaces whole years.
- `npm run etl:harmonize`: → `<out>/calibration/k.parquet` (fitted year by year, reused unless params/countries change or `--recalibrate`) + `<out>/harmonized/year=/part_0.parquet` (0.1° cell × day: `h`, `h_modis`, `h_viirs`, `n_modis`, `n_viirs`, `country`) + `<out>/harmonized_monthly/year=/` (0.1° cell × month, adds `fire_days`). Calendar → monthly, map/daily → daily, CSV → hotspots. `--monthly-only` rebuilds just the monthly aggregate.
- `npm run etl:validate`: data quality, harmonization quality (`--oos` adds the out-of-sample test, slow on world data) and API query speed; PASS/WARN/FAIL, saved to `data/reports/validate-<scope>.json`.
- `npm run etl:report`: → `data/reports/etl-report-<scope>.html` (before/after charts, sensor agreement, calendar, k table). Open the generated file, not `report.template.html`.
- `npm run etl:all` runs normalize, harmonize and report. Scope flags: `--countries Greece|*`, `--years 2000-2025`, `--input`, `--output`, `--force`, `--recalibrate`. Dev default: Greece in `data/parquet`; world: `--countries '*' --input data --output data/parquet_global`.
