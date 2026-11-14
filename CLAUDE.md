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

Known limits: Terra's orbit drifts after ~2020 (global 2025 k ≈ 0.3–0.5 vs ~0.8 historically), so time-varying k for Terra is a possible improvement. After Aqua ends, new satellites need chained calibration (via S-NPP/NOAA-20); not implemented yet.

## ETL commands

- `npm run etl:normalize`: raw CSV → `data/parquet/hotspots/year=/country=/` (common schema, nothing dropped, incremental).
- `npm run etl:harmonize`: → `data/parquet/calibration/k.parquet` + `data/parquet/harmonized/year=/part_0.parquet` (0.1° cell × day: `h`, `h_modis`, `h_viirs`, `n_modis`, `n_viirs`, `country`). The calendar and map use `h`.
- `npm run etl:report`: → `data/reports/etl-report-<scope>.html` (before/after charts, calendar, k table).
- `npm run etl:all` runs all three. Scope flags: `--countries Greece|*`, `--years 2000-2025`, `--input`, `--output`, `--force`, `--recalibrate`.

# Original challenge descirption
Understanding how burning activity is distributed across our planet over time, including wildfires and agricultural burns intense enough to be detected by satellite sensors, enables us to anticipate critical periods, guide monitoring efforts, and improve fire response. Satellites have tracked active fire hotspots for more than two decades, but the record is split across sensors whose data cannot be compared directly, leaving fire managers without a consistent picture of when and where burning has occurred. Your challenge is to build a web application that harmonizes these records into a burning activity calendar based on active fire hotspots, enabling early warning and emergency responders, scientists, and land managers to examine historical fire patterns, unusual conditions, and critical periods within a selected area of interest.


Background
Fire regimes

Some ecosystems need periodic fires to maintain their function and their structure. However, changes in fire intensity, extent, and frequency can have negative impacts on climate, society, and biodiversity, along with the ecosystem services they provide. Fires can also cause loss of life and properties, degradation of health, and acute risk to fire managers.

Because humans have modified global patterns of vegetation, ignition, and climate over millennia, fires on both local and global scales are increasingly human-related.

Burning activity involves wildfires in natural vegetation and forested areas, as well as anthropogenic fires associated with agriculture, land-clearing, waste disposal, and industrial activities. It is one of the many dynamic phenomena that can be detected with remote sensing.

Satellite fire detection and monitoring

Climate models project that fire weather will become more common and more intense. Earth Observation (EO) satellites provide technological solutions for early detection, rapid response, and postfire assessment, measuring thermal radiation and smoke across regional to global scales.

Detecting hotspots on Earth's surface

EO satellites provide information on fire location, intensity, and temporal evolution. Satellite sensors operating in the thermal infrared (TIR) range can detect hotspots on the Earth's surface generated by urban and wildfires, volcanic eruptions, and industrial processes such as gas flares in oil and gas operations.

For active fires, detection and monitoring rely mainly on mid-infrared (MIR) and TIR measurements, where active combustion produces its stronger signal. Sensors such as MODIS and VIIRS provide real-time thermal anomaly detection, enabling early hotspot identification and the assessment of burned areas.

Burn activity calendars

Using satellite-detected hotspots, fire activity calendars can be developed by integrating historical information with recent data, allowing for the rapid visual identification of seasonal patterns, anomalies, and trends in each region.

MODIS sensors on board Terra and Aqua satellites provide more than two decades of observations, but they are approaching the end of their operational life and are being replaced by VIIRS sensors. Their records cannot be directly compared without harmonization, since MODIS and VIIRS have different spatial resolutions, sensitivities, and observation schedules.

Therein lies the root of the challenge. As fire frequency and intensity increase, emergency managers benefit from an updated and consistent hotspot calendar that enables them to rapidly visualize, for example, which month and years had the highest fire activity, and compare the burning activity of the current month against the historical median for a selected area.

You may consider harmonizing NASA Earthdata FIRMS hotspots, combining the extensive historical series of MODIS with the continuity and greater detail of VIIRS.

Emergency managers could then use the web application to monitor sensitive regions, recognize changes relative to historical patterns, and strengthen fire forecasting and response.

Objectives
Your challenge is to develop a harmonized burning activity calendar based on active fire hotspots in a web application, combining the extensive historical series of MODIS with the continuity and greater detail of VIIRS to provide a consistent time series of hotspot activity.

This challenge could be approached in two parts. The first is MODIS and VIIRS hotspot harmonization, so that by the end of that phase the sensor of origin no longer matters and the patterns, trends, and anomalies become the focus.

The second involves developing a web application that takes harmonized hotspot data as input. Through this visual tool, a user could select a region and a specific date range, then download analytics and visualizations of fire activity.

A calendar of burning activity showing the number of hotspots detected from the early 2000s to the present, built on the harmonized hotspots dataset and integrated into the web application, would give emergency managers a view of the fire history of an area: which periods of the year see more fires, which years had more burning activity, and how a current fire compares with previous ones.

In addition to numerical information, you could consider how color ramps might represent similarities and differences in the number of detected hotspots across months, providing an accessible and intuitive way to visualize fire activity. A downloadable CSV File of hot spots detected during a search would be another useful output.

Potential Considerations
You may (but are not required to) consider the following:

Your target audience can include early warning and emergency responders, scientists, land managers, and firefighters.
Consider making your web application interactive – for example, a map where users can draw the area of interest, or an option to enter latitude and longitude.
Consider using accessible color ramps.
Your tool could depict a burning calendar
Your tool could focus on a few key indices and figures and present them through data visualizations, such as:
Historical comparisons, including anomalies against multi-year averages
Number of fires detected and reported
For data and resources related to this challenge, refer to the Resources tab at the top of the page. More resources may be added before the hackathon begins.

Photo credit: The National Commission on Space Activities of Argentina (CONAE)