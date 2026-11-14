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

## Tech stack (decided)

- **Monorepo:** `etl/`, `server/`, `web/`.
- **TypeScript** everywhere (pragmatic, non-strict is fine; backend run with `tsx`).
- **ETL (`etl/`):** TypeScript + DuckDB (`@duckdb/node-api`). Converts raw CSV/ZIP → harmonized Parquet + pre-aggregates.
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

- Source: NASA FIRMS active-fire CSVs, one **ZIP per year containing all countries** (~400 MB for recent years, older years much smaller), ~25 years (2000 → present), ~6 GB total.
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
- ETL is **incremental, ZIP by ZIP**, writing Parquet partitioned by `year=/country=`. Adding a year or country means adding a partition.
- For the demo, prove scalability by running 1–2 full global years (or everything) and reporting timings (ETL per year, global calendar query, CSV export).

## Harmonization rules (MODIS + VIIRS)

- Filter `type`: keep `0` (presumed vegetation fire); drop `2` (static land source / industrial) and other non-vegetation types.
- Map confidence to common classes: VIIRS `l/n/h` ↔ MODIS 0–100 (e.g. <30 low, 30–80 nominal, >80 high).
- Raw counts are **not comparable**: VIIRS (375 m) detects several times more than MODIS (1 km), and the number of satellites grows over time (2000 Terra → 2002 +Aqua → 2012 +S-NPP → 2018 +NOAA-20 → 2024 +NOAA-21). Summing raw points creates a fake upward trend.
- Approach: aggregate to a common grid (~1 km or H3) and count **active cells per day** (deduplicating detections across satellites), and/or calibrate a MODIS↔VIIRS ratio over the overlap period (2012 → present). The goal: after harmonization the sensor of origin no longer matters.
