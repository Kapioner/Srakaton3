import { Download, MapPin } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  Bbox,
  CalendarResponse,
  GridResponse,
  HealthResponse,
  MetaResponse,
  Region,
  ReportResponse,
  SeriesResponse,
  SummaryResponse,
} from '../../shared/api.ts';
import { api, isAbort } from './api.ts';
import { Calendar, type CalendarMode } from './components/Calendar.tsx';
import { FireMap } from './components/FireMap.tsx';
import { LocationsPanel } from './components/LocationsPanel.tsx';
import { ReportCharts } from './components/ReportCharts.tsx';
import { ALL_DATA, QueryPanel, type Query } from './components/QueryPanel.tsx';
import { Scramble } from './components/Scramble.tsx';
import { SeriesChart } from './components/SeriesChart.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { loadLocations, saveLocations, type WatchLocation } from './features/locations.ts';
import { dataColors } from './theme.ts';

const nf = new Intl.NumberFormat('en-US');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One loadable view: its data, whether a request is running, and its own error (one failing view does not blank the page). */
interface View<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}
const idle = <T,>(): View<T> => ({ data: null, loading: false, error: null });

function useView<T>() {
  const [view, setView] = useState<View<T>>(idle<T>());
  const load = useCallback((p: Promise<T>) => {
    setView((v) => ({ ...v, loading: true, error: null }));
    p.then((data) => setView({ data, loading: false, error: null })).catch((e: unknown) => {
      if (isAbort(e)) return;
      setView((v) => ({ ...v, loading: false, error: (e as Error).message }));
    });
  }, []);
  return [view, load] as const;
}

/** Dashboard: sidebar | query + map + calendar + charts | watch locations. */
export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [query, setQuery] = useState<Query>(ALL_DATA);
  const [calendar, loadCalendar] = useView<CalendarResponse>();
  const [summary, loadSummary] = useView<SummaryResponse>();
  const [series, loadSeries] = useView<SeriesResponse>();
  const [report, loadReport] = useView<ReportResponse>();
  const [grid, loadGrid] = useView<GridResponse>();
  const [mapViewState, setMapViewState] = useState<Bbox | null>(null);

  const [calendarMode, setCalendarMode] = useState<CalendarMode>('count');
  const [locations, setLocations] = useState<WatchLocation[]>(loadLocations);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  // Locations drawer over the map: hidden by default so the map gets the full width.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Esc leaves "add location" mode.
  useEffect(() => {
    if (!addMode) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAddMode(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addMode]);

  // Dataset facts: once. `npm run dev` starts Vite (~0.5 s) before the API (~4 s), so wait until the API
  // answers instead of showing a connection error on the first load; nothing else loads before that.
  const [apiReady, setApiReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const [m, r, h] = await Promise.all([api.meta(), api.regions(), api.health()]);
          if (cancelled) return;
          setMeta(m);
          setRegions(r.regions);
          setHealth(h);
          setBootError(null);
          setApiReady(true);
          return;
        } catch (e) {
          if (cancelled) return;
          if (attempt >= 60) return setBootError((e as Error).message);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The calendar and the sensor chart always show the region's whole history (that is what the selected
  // period is compared against), so they only reload when the region changes.
  const regionKey = `${query.bbox?.join(',') ?? 'all'}|${query.country ?? ''}`;
  useEffect(() => {
    if (!apiReady) return;
    const ctrl = new AbortController();
    const region = { bbox: query.bbox, country: query.country };
    loadCalendar(api.calendar(region, ctrl.signal));
    loadSeries(api.series(region, ctrl.signal));
    loadReport(api.report(region, ctrl.signal));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, regionKey, loadCalendar, loadSeries, loadReport]);

  // Map and summary follow the full query (region + dates). A new query aborts the previous requests.
  useEffect(() => {
    if (!apiReady) return;
    const ctrl = new AbortController();
    loadSummary(api.summary(query, ctrl.signal));
    loadGrid(api.grid(query, ctrl.signal));
    return () => ctrl.abort();
  }, [apiReady, query, loadSummary, loadGrid]);

  useEffect(() => saveLocations(locations), [locations]);

  const onViewChange = useCallback((b: Bbox) => {
    setMapViewState(b);
  }, []);

  const addLocation = ({ lng, lat }: { lng: number; lat: number }) => {
    const loc: WatchLocation = {
      id: crypto.randomUUID(),
      name: `Location ${locations.length + 1}`,
      longitude: Number(lng.toFixed(5)),
      latitude: Number(lat.toFixed(5)),
      createdAt: new Date().toISOString(),
    };
    setLocations((prev) => [...prev, loc]);
    setSelectedId(loc.id);
    setAddMode(false);
  };

  const removeLocation = (id: string) => {
    setLocations((prev) => prev.filter((l) => l.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // Dataset span for the headline (a leading year with only a few weeks of data does not count).
  const firstYear = meta ? Number(meta.dateRange.from.slice(0, 4)) + (Number(meta.dateRange.from.slice(5, 7)) > 2 ? 1 : 0) : 2001;
  const lastYear = meta ? Number(meta.dateRange.to.slice(0, 4)) : 2025;
  const span = lastYear - firstYear + 1;
  const datasetName = meta?.countries.length ? (meta.countries.length > 3 ? `${meta.countries.length} countries` : meta.countries.join(' / ')) : 'the region';
  const agreement = meta?.harmonization.sensorAgreement;
  const scopeCode = meta ? `${meta.countries.length > 3 ? 'WORLD' : meta.countries.map((c) => c.slice(0, 2).toUpperCase()).join('-')}_${firstYear}-${lastYear}` : '--';
  const csvUrl = api.exportCsvUrl(query);
  const busy = calendar.loading || summary.loading || series.loading || grid.loading;
  const fixtures = (health?.source ?? meta?.source) === 'fixtures';
  const s = summary.data;
  const cmp = s?.comparison;

  return (
    <div className="page" id="top">
      <div className="frame app-shell">
        <Sidebar meta={meta} gridCells={grid.data?.features.length ?? 0} locations={locations.length} scopeCode={scopeCode} />

        <main className="main-content">
          <header className="topbar">
            <div className="breadcrumb label">
              <span className="dim">Workspace</span>
              <span className="dim">/</span>
              <strong>{query.label === ALL_DATA.label ? datasetName : query.label}</strong>
            </div>
            <div className="topbar-right">
              {busy && <span className="status label warn">Querying</span>}
              {health && (
                <span className={`status label ${fixtures ? 'warn' : 'ok'}`} title={health.reason ?? health.parquetDir}>
                  <span className="status-dot" />
                  {fixtures ? 'Sample data (fixtures)' : 'Parquet dataset'}
                </span>
              )}
              <a className="topbar-link label" href={csvUrl}>
                <Download size={15} />
                CSV
              </a>
            </div>
          </header>

          <section className="heading">
            <div>
              <div className="eyebrow label">
                <span className="red-line" />
                Harmonized MODIS + VIIRS hotspots
              </div>
              <h1 className="headline">
                <Scramble text={`${span} years of fire on one calendar.`} delay={150} />
              </h1>
            </div>
            <p className="lede">
              Active-fire detections over {datasetName}, <i><b>harmonized</b></i> so the sensor no longer matters. Pick a region and a
              period: see which months burn, which years were worst, and how this period compares.
            </p>
          </section>

          {bootError && <p className="error">API error: {bootError}. Is the server running on port 3001?</p>}
          {fixtures && health?.reason && (
            <p className="notice">
              Showing sample responses: region and date filters are not applied. {health.reason}.
            </p>
          )}

          <QueryPanel meta={meta} regions={regions} query={query} mapView={mapViewState} busy={busy} onApply={setQuery} />

          {cmp && s && (
            <p className="insight" aria-live="polite">
              <span className="label dim">Selected period</span>
              <span>
                <b className="mono">{nf.format(Math.round(cmp.periodValue))}</b> fire cell-days
                {cmp.ratio !== null && cmp.outOf > 1 ? (
                  <>
                    {' '}
                    · <b className={`mono ${cmp.ratio >= 1.5 ? 'hot' : cmp.ratio <= 0.67 ? 'cool' : ''}`}>{cmp.ratio.toFixed(1)}×</b> the same
                    period in other years · rank <b className="mono">{cmp.rank}</b> of {cmp.outOf} ({cmp.baselineYears[0]}–{cmp.baselineYears[1]})
                  </>
                ) : (
                  <> · choose a period of up to one year to compare it with other years</>
                )}
              </span>
            </p>
          )}

          <section id="map" className="block">
            <FireMap
              grid={grid.data}
              bbox={query.fit ?? query.bbox ?? meta?.bbox ?? null}
              selection={query.bbox}
              onViewChange={onViewChange}
              locations={locations}
              selectedId={selectedId}
              addMode={addMode}
              onAdd={addLocation}
              onSelect={(id) => {
                setSelectedId(id);
                setDrawerOpen(true);
              }}
              drawerOpen={drawerOpen}
            >
              {!drawerOpen && (
                <button type="button" className="drawer-toggle" onClick={() => setDrawerOpen(true)} aria-expanded={false}>
                  <MapPin size={15} />
                  Locations
                </button>
              )}
              <LocationsPanel
                open={drawerOpen}
                locations={locations}
                selectedId={selectedId}
                addMode={addMode}
                grid={grid.data}
                onClose={() => {
                  setDrawerOpen(false);
                  setAddMode(false);
                }}
                onToggleAdd={() => setAddMode((v) => !v)}
                onSelect={setSelectedId}
                onRemove={removeLocation}
              />
            </FireMap>
            {grid.error && <p className="error">Map: {grid.error}</p>}
          </section>

          <section className="stats" aria-label="Key numbers">
            <div className="stat">
              <span className="label dim">Peak year</span>
              <b className="mono">{s?.peakYear?.year ?? '----'}</b>
            </div>
            <div className="stat">
              <span className="label dim">Peak month</span>
              <b className="mono">{s?.peakMonth ? `${MONTHS[s.peakMonth.month - 1]} ${s.peakMonth.year}` : '--- ----'}</b>
            </div>
            <div className="stat">
              <span className="label dim">Raw detections</span>
              <b className="mono" style={{ color: dataColors.raw }}>
                {s ? nf.format(s.rawDetections) : '------'}
              </b>
            </div>
            <div className="stat">
              <span className="label dim">MODIS vs VIIRS gap</span>
              <b className="mono" style={{ color: dataColors.ok }}>
                {agreement ? `±${Math.round(agreement.meanAbsLogRatio * 100)}%` : '--'}
              </b>
            </div>
          </section>
          {summary.error && <p className="error">Summary: {summary.error}</p>}

          <section id="calendar" className="block">
            <div className="section-head">
              <h2>
                <span className="idx">01</span>Burning activity calendar
              </h2>
              <div className="segmented" role="group" aria-label="Calendar colouring">
                <button type="button" aria-pressed={calendarMode === 'count'} onClick={() => setCalendarMode('count')}>
                  Fire cell-days
                </button>
                <button type="button" aria-pressed={calendarMode === 'anomaly'} onClick={() => setCalendarMode('anomaly')}>
                  vs. normal
                </button>
              </div>
            </div>
            <p className="section-note">
              {calendarMode === 'count'
                ? `${calendar.data?.unit ?? 'Harmonized activity'} per month in ${query.label === ALL_DATA.label ? datasetName : query.label}, log colour scale${query.from || query.to ? '; outlined: the selected period' : ''}.`
                : 'Each month against its long-term mean: blue is quieter than normal, red and gold are worse.'}
            </p>
            <div className={`chart-box ${calendar.loading ? 'is-loading' : ''}`}>
              {calendar.data ? (
                <Calendar data={calendar.data} mode={calendarMode} highlight={query.from || query.to ? { from: query.from, to: query.to } : null} />
              ) : (
                <p className={calendar.error ? 'error' : 'loading'}>{calendar.error ?? 'Loading calendar'}</p>
              )}
            </div>
          </section>

          <section id="series" className="block">
            <div className="section-head">
              <h2>
                <span className="idx">02</span>Does the sensor still matter?
              </h2>
            </div>
            <p className="section-note">
              The harmonized series next to the same estimate from MODIS only and VIIRS only. Raw detections (grey bars) jump
              whenever a satellite is added; the harmonized lines do not.
            </p>
            <div className={`chart-box ${series.loading ? 'is-loading' : ''}`}>
              {series.data ? (
                <SeriesChart data={series.data} />
              ) : (
                <p className={series.error ? 'error' : 'loading'}>{series.error ?? 'Loading series'}</p>
              )}
            </div>
          </section>

          <section id="report" className="block">
            <div className="section-head">
              <h2>
                <span className="idx">03</span>Harmonization report
              </h2>
              <span className="label dim">same as npm run etl:report · {query.label === ALL_DATA.label ? datasetName : query.label}</span>
            </div>
            <div className={report.loading ? 'is-loading' : ''}>
              {report.data ? (
                <ReportCharts report={report.data} series={series.data} />
              ) : (
                <p className={report.error ? 'error' : 'loading'}>{report.error ?? 'Loading report'}</p>
              )}
            </div>
          </section>

          <section id="method" className="block method">
            <div className="section-head">
              <h2>
                <span className="idx">04</span>Method
              </h2>
            </div>
            <ul className="tags">
              <li>* Fire cell-day: {meta?.harmonization.fineGridDeg ?? 0.02}° cell, vegetation fires only (type 0)</li>
              <li>** Five fire-size classes by FRP: {meta?.harmonization.frpEdges.join(' / ') ?? '5 / 10 / 20 / 40'} MW</li>
              <li>*** Every satellite calibrated to MODIS {meta?.harmonization.reference ?? 'Aqua'} per class</li>
              <li>**** Satellites combined per day: h = Σ n / Σ k</li>
            </ul>
          </section>

          <footer className="footer">
            <span className="label dim mono">
              {scopeCode}
              {health && !fixtures && (
                <>
                  <br />
                  DuckDB {health.duckdb} · {health.limits.memoryLimit} · {health.limits.threads} threads
                </>
              )}
            </span>
            <a className="btn" href={csvUrl}>
              Download hotspots CSV
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}
