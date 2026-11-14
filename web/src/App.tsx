import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CalendarResponse, GridResponse, MetaResponse, SeriesResponse, SummaryResponse } from '../../shared/api.ts';
import { api, type HealthResponse } from './api.ts';
import { Calendar, type CalendarMode } from './components/Calendar.tsx';
import { FireMap } from './components/FireMap.tsx';
import { LocationsPanel } from './components/LocationsPanel.tsx';
import { Scramble } from './components/Scramble.tsx';
import { SeriesChart } from './components/SeriesChart.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { loadLocations, saveLocations, type WatchLocation } from './features/locations.ts';
import { dataColors } from './theme.ts';

const nf = new Intl.NumberFormat('en-US');

/** Dashboard: sidebar | map + calendar + charts | watch locations. */
export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [series, setSeries] = useState<SeriesResponse | null>(null);
  const [grid, setGrid] = useState<GridResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [calendarMode, setCalendarMode] = useState<CalendarMode>('count');
  const [locations, setLocations] = useState<WatchLocation[]>(loadLocations);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);

  useEffect(() => {
    Promise.all([api.meta(), api.calendar({}), api.summary({}), api.series({}), api.grid({}), api.health()])
      .then(([m, c, s, se, g, h]) => {
        setMeta(m);
        setCalendar(c);
        setSummary(s);
        setSeries(se);
        setGrid(g);
        setHealth(h);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => saveLocations(locations), [locations]);

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

  const [firstYear, lastYear] = calendar?.baselineYears ?? [2001, 2025];
  const span = lastYear - firstYear + 1;
  const region = meta?.countries.join(' / ') ?? 'the region';
  const agreement = meta?.harmonization.sensorAgreement;
  const scopeCode = meta ? `${meta.countries.map((c) => c.slice(0, 2).toUpperCase()).join('-')}_${firstYear}-${lastYear}` : '--';
  const csvUrl = api.exportCsvUrl({});

  return (
    <div className="page" id="top">
      <div className="frame app-shell">
        <Sidebar meta={meta} gridCells={grid?.features.length ?? 0} locations={locations.length} scopeCode={scopeCode} />

        <main className="main-content">
          <header className="topbar">
            <div className="breadcrumb label">
              <span className="dim">Workspace</span>
              <span className="dim">/</span>
              <strong>{region}</strong>
            </div>
            <div className="topbar-right">
              {health && (
                <span className={`status label ${health.fixtures ? 'warn' : 'ok'}`}>
                  <span className="status-dot" />
                  {health.fixtures ? 'Sample data (fixtures)' : 'Live data'}
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
                <Scramble text={`${span} years of fire.`} delay={150} /> <Scramble text="One calendar." delay={450} />
              </h1>
            </div>
            <p className="lede">
              Active-fire detections over {region}, harmonized so the sensor no longer matters. See which months burn,
              which years were worst, and how today compares.
            </p>
          </section>

          {error && <p className="error">API error: {error}. Is the server running on port 3001?</p>}

          <section id="map" className="block">
            <FireMap
              grid={grid}
              bbox={meta?.bbox ?? null}
              locations={locations}
              selectedId={selectedId}
              addMode={addMode}
              onAdd={addLocation}
              onSelect={setSelectedId}
            />
          </section>

          <section className="stats" aria-label="Key numbers">
            <div className="stat">
              <span className="label dim">Peak year</span>
              <b className="mono">{summary?.peakYear?.year ?? '----'}</b>
            </div>
            <div className="stat">
              <span className="label dim">Peak month</span>
              <b className="mono">
                {summary?.peakMonth ? `${String(summary.peakMonth.month).padStart(2, '0')}/${summary.peakMonth.year}` : '--/----'}
              </b>
            </div>
            <div className="stat">
              <span className="label dim">Raw detections</span>
              <b className="mono" style={{ color: dataColors.raw }}>
                {summary ? nf.format(summary.rawDetections) : '------'}
              </b>
            </div>
            <div className="stat">
              <span className="label dim">MODIS vs VIIRS gap</span>
              <b className="mono" style={{ color: dataColors.ok }}>
                {agreement ? `±${Math.round(agreement.meanAbsLogRatio * 100)}%` : '--'}
              </b>
            </div>
          </section>

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
                ? `${calendar?.unit ?? 'Harmonized activity'} per month, log colour scale.`
                : 'Each month against its long-term mean: blue is quieter than normal, red and gold are worse.'}
            </p>
            <div className="chart-box">
              {calendar ? <Calendar data={calendar} mode={calendarMode} /> : !error && <p className="loading">Loading calendar</p>}
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
            <div className="chart-box">{series ? <SeriesChart data={series} /> : !error && <p className="loading">Loading series</p>}</div>
          </section>

          <section id="method" className="block method">
            <div className="section-head">
              <h2>
                <span className="idx">03</span>Method
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
            <span className="label dim mono">{scopeCode}</span>
            <a className="btn" href={csvUrl}>
              Download hotspots CSV
            </a>
          </footer>
        </main>

        <LocationsPanel
          locations={locations}
          selectedId={selectedId}
          addMode={addMode}
          grid={grid}
          onToggleAdd={() => setAddMode((v) => !v)}
          onSelect={setSelectedId}
          onRemove={removeLocation}
        />
      </div>
    </div>
  );
}
