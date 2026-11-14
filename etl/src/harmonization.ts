// Harmonization method (ETL step 2) - parameters and SQL.
//
// Problem: MODIS (1 km) and VIIRS (375 m) count fires differently. VIIRS splits one fire into many pixels
// AND sees small fires MODIS misses; and the number of satellites grows over time. Raw sums show a fake trend.
//
// Method: "FRP-stratified, multi-satellite calibration to an Aqua-equivalent fire cell-day".
//   1. Common unit: a fire cell-day = one fine grid cell (FINE_GRID_DEG) with >= 1 vegetation-fire detection
//      (type 0) by one satellite on one day. This removes the pixel-size effect.
//   2. Fire size classes: each satellite's cell-day goes to a class by its summed FRP (FRP_EDGES, MW).
//      VIIRS/MODIS ratio depends strongly on fire size (small fires are VIIRS-only), so one constant
//      factor under-estimates big-fire years by 20-40%. Per class the ratio is stable.
//   3. Calibration: for every satellite s and class c, k[s,c] = cell-days(s,c) / cell-days(REFERENCE,c)
//      over the period both fly, per country, shrunk towards the global value (SHRINK_ALPHA) where data is thin.
//   4. Combination (Poisson maximum likelihood): on a day with active satellites S,
//         h = sum_c ( sum_{s in S} n[s,c] ) / ( sum_{s in S} k[s,c] )
//      i.e. every satellite is an independent, calibrated estimate of the same Aqua-equivalent count.
//      Adding/losing a satellite changes the noise, not the level. h_modis / h_viirs use one family only,
//      so their agreement in the overlap (2012+) is the proof that the sensor no longer matters.
// Validated on Greece: fitted on 2012-2020 only, it predicts the record years 2021/2023 within 0-9 %
// (a single constant factor misses them by 35-41 %).

export const HARMONIZATION = {
  version: 1,
  fineGridDeg: 0.02, // ~2 km: unit of a fire cell-day (dedup + calibration)
  outGridDeg: 0.1, // ~10 km: storage grid of the harmonized daily aggregate
  frpEdges: [5, 10, 20, 40], // MW, class boundaries -> classes 0..4
  reference: 'Aqua', // MODIS Aqua: flies 2002-today, same overpass time as S-NPP/NOAA-20
  shrinkAlpha: 50, // pseudo-count pulling a country's k towards the global k
};

export type HarmonizationParams = typeof HARMONIZATION;

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function frpClassSql(col: string, p: HarmonizationParams): string {
  return `CASE ${p.frpEdges.map((e, i) => `WHEN ${col} < ${e} THEN ${i}`).join(' ')} ELSE ${p.frpEdges.length} END`;
}

/** One row per satellite x fine cell x day (vegetation fires only). `where` filters the `hotspots` view. */
export function subCellDaysSql(where: string, p: HarmonizationParams): string {
  return `
    SELECT acq_date, year, satellite, any_value(sensor) AS sensor,
           floor(latitude / ${p.fineGridDeg})::INTEGER AS gi,
           floor(longitude / ${p.fineGridDeg})::INTEGER AS gj,
           mode(country) AS country,
           count(*)::INTEGER AS n,
           ${frpClassSql('sum(coalesce(frp, 0))', p)} AS cls
    FROM hotspots
    WHERE type = 0 AND (${where})
    GROUP BY acq_date, year, satellite, gi, gj`;
}

/** Satellite availability (first/last day with data) - defines which satellites "fly" on a given day. */
export const satellitesSql = `
  SELECT satellite, any_value(sensor) AS sensor, min(acq_date) AS first_date, max(acq_date) AS last_date
  FROM hotspots GROUP BY satellite ORDER BY first_date`;

/**
 * Calibration factors k(country, satellite, cls) relative to the reference satellite.
 * Expects tables `sub` (subCellDaysSql over all years) and `sats` (satellitesSql).
 */
export function calibrationSql(p: HarmonizationParams): string {
  const ref = lit(p.reference);
  const classes = Array.from({ length: p.frpEdges.length + 1 }, (_, i) => i).join(', ');
  return `
    WITH ov AS (            -- overlap window of every satellite with the reference
      SELECT t.satellite AS target, greatest(t.first_date, r.first_date) AS d0, least(t.last_date, r.last_date) AS d1
      FROM sats t, sats r WHERE r.satellite = ${ref}
    ),
    pairs AS (
      SELECT ov.target AS satellite, x.country, x.cls,
             count(*) FILTER (WHERE x.satellite = ov.target) AS n_sat,
             count(*) FILTER (WHERE x.satellite = ${ref}) AS n_ref
      FROM sub x JOIN ov ON x.acq_date BETWEEN ov.d0 AND ov.d1 AND x.satellite IN (ov.target, ${ref})
      GROUP BY ALL
    ),
    glob_k AS (
      SELECT satellite, cls, sum(n_sat) AS n_sat, sum(n_ref) AS n_ref,
             CASE WHEN sum(n_ref) > 0 THEN sum(n_sat) / sum(n_ref) END AS k
      FROM pairs GROUP BY ALL
    ),
    grid AS (               -- every country x satellite x class, so missing combinations fall back to global
      SELECT c.country, s.satellite, cl.cls
      FROM (SELECT DISTINCT country FROM sub) c, sats s, (SELECT unnest([${classes}]) AS cls) cl
    )
    SELECT g.country, g.satellite, g.cls,
           coalesce(p.n_sat, 0) AS n_sat, coalesce(p.n_ref, 0) AS n_ref,
           CASE WHEN g.satellite = ${ref} THEN 1.0
                ELSE (coalesce(p.n_sat, 0) + ${p.shrinkAlpha} * gl.k) / (coalesce(p.n_ref, 0) + ${p.shrinkAlpha})
           END AS k,
           gl.k AS k_global
    FROM grid g
    LEFT JOIN pairs p USING (country, satellite, cls)
    LEFT JOIN glob_k gl USING (satellite, cls)
    WHERE g.satellite = ${ref} OR gl.k IS NOT NULL
    ORDER BY ALL`;
}

/**
 * Harmonized daily aggregate on the output grid for the rows matched by `where`.
 * Expects tables `calib` (calibrationSql) and `sats`.
 */
export function harmonizedDailySql(where: string, p: HarmonizationParams): string {
  const ratio = Math.round(p.outGridDeg / p.fineGridDeg);
  if (Math.abs(ratio * p.fineGridDeg - p.outGridDeg) > 1e-9) throw new Error('outGridDeg must be a multiple of fineGridDeg');
  return `
    WITH sub AS (${subCellDaysSql(where, p)}),
    act AS (SELECT * FROM sats WHERE satellite IN (SELECT DISTINCT satellite FROM calib)),
    den AS (                -- sum of k over satellites flying that day, per country and class
      SELECT r.country, r.cls, r.acq_date,
             sum(c.k) AS all_k,
             sum(c.k) FILTER (WHERE a.sensor = 'MODIS') AS m_k,
             sum(c.k) FILTER (WHERE a.sensor = 'VIIRS') AS v_k
      FROM (SELECT DISTINCT country, cls, acq_date FROM sub) r
      JOIN act a ON r.acq_date BETWEEN a.first_date AND a.last_date
      JOIN calib c ON c.country = r.country AND c.satellite = a.satellite AND c.cls = r.cls
      GROUP BY ALL
    ),
    flags AS (
      SELECT d.acq_date, bool_or(a.sensor = 'MODIS') AS m_on, bool_or(a.sensor = 'VIIRS') AS v_on
      FROM (SELECT DISTINCT acq_date FROM sub) d JOIN act a ON d.acq_date BETWEEN a.first_date AND a.last_date
      GROUP BY ALL
    ),
    w AS (
      SELECT s.*, floor(s.gi / ${ratio}.0)::INTEGER AS cell_lat, floor(s.gj / ${ratio}.0)::INTEGER AS cell_lon,
             1.0 / d.all_k AS w,
             CASE WHEN s.sensor = 'MODIS' THEN 1.0 / d.m_k END AS wm,
             CASE WHEN s.sensor = 'VIIRS' THEN 1.0 / d.v_k END AS wv
      FROM sub s JOIN den d USING (country, cls, acq_date)
    )
    SELECT w.year, w.acq_date, w.cell_lat, w.cell_lon,
           round((w.cell_lat + 0.5) * ${p.outGridDeg}, 4) AS lat,
           round((w.cell_lon + 0.5) * ${p.outGridDeg}, 4) AS lon,
           mode(country) AS country,
           round(sum(w), 5) AS h,
           CASE WHEN any_value(f.m_on) THEN round(coalesce(sum(wm), 0), 5) END AS h_modis,
           CASE WHEN any_value(f.v_on) THEN round(coalesce(sum(wv), 0), 5) END AS h_viirs,
           (coalesce(sum(n) FILTER (WHERE sensor = 'MODIS'), 0))::INTEGER AS n_modis,
           (coalesce(sum(n) FILTER (WHERE sensor = 'VIIRS'), 0))::INTEGER AS n_viirs
    FROM w JOIN flags f USING (acq_date)
    GROUP BY w.year, w.acq_date, w.cell_lat, w.cell_lon
    ORDER BY w.cell_lat, w.cell_lon, w.acq_date`;
}
