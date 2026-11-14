import { useEffect, useState } from 'react';
import type { CalendarResponse, MetaResponse, SummaryResponse } from '../../shared/api.ts';
import { api } from './api.ts';
import { Calendar } from './components/Calendar.tsx';
import { Clock } from './components/Clock.tsx';
import { Scramble } from './components/Scramble.tsx';

const nf = new Intl.NumberFormat('en-US');

// Stage 0 screen in the house style. Stage 4 adds the map, region selection and the remaining charts
// from docs/PLAN.md into the same frame.
export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.meta(), api.calendar({}), api.summary({})])
      .then(([m, c, s]) => {
        setMeta(m);
        setCalendar(c);
        setSummary(s);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const firstYear = calendar?.baselineYears[0];
  const lastYear = calendar?.baselineYears[1];
  const span = firstYear && lastYear ? lastYear - firstYear + 1 : 25;
  const region = meta?.countries.join(' / ') ?? 'Region';
  const agreement = meta?.harmonization.sensorAgreement;
  const scopeCode = meta ? `${meta.countries.map((c) => c.slice(0, 2).toUpperCase()).join('-')}_${firstYear}-${lastYear}` : 'SCOPE';

  return (
    <div className="page">
      <main className="frame">
        <header className="cols topbar label">
          <span className="brand">Firecal</span>
          <nav aria-label="Sections">
            <a href="#calendar">Calendar</a>
            <a href="#map">Map</a>
            <a href="#method">Method</a>
          </nav>
          <div className="right">
            <a href={api.exportCsvUrl({})}>Download CSV</a>
          </div>
        </header>

        <div className="rule" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>

        <section className="cols hero">
          <h1 className="headline">
            <Scramble text={`${span} years of fire.`} delay={150} />
            <br />
            <Scramble text="One calendar." delay={450} />
          </h1>
          <div className="deco" aria-hidden="true">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 170 }}>
              <span className="barcode" />
              <span className="barcode wide" />
            </div>
          </div>
          <div>
            <p className="lede">
              MODIS and VIIRS active-fire hotspots over {region}, harmonized so the sensor no longer matters. See which
              months burn, which years were worst, and how today compares.
            </p>
            {meta && (
              <ul className="tags" aria-label="Satellites in the series">
                {meta.satellites.map((s, i) => (
                  <li key={s.satellite}>
                    {'*'.repeat(i + 1)} {s.satellite} · {s.sensor} · {s.from.slice(0, 4)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {error && <p className="error">API error: {error}. Is the server running on port 3001?</p>}

        <section className="stats" aria-label="Key numbers">
          <div className="stat label">
            Peak year
            <b>{summary?.peakYear?.year ?? '----'}</b>
          </div>
          <div className="stat label">
            Peak month
            <b>
              {summary?.peakMonth
                ? `${String(summary.peakMonth.month).padStart(2, '0')}/${summary.peakMonth.year}`
                : '--/----'}
            </b>
          </div>
          <div className="stat label">
            Raw detections
            <b>{summary ? nf.format(summary.rawDetections) : '------'}</b>
          </div>
          <div className="stat label">
            MODIS vs VIIRS gap
            <b>{agreement ? `±${Math.round(agreement.meanAbsLogRatio * 100)}%` : '--'}</b>
          </div>
        </section>

        <section id="calendar">
          <div className="section-head">
            <h2>
              <span className="idx">01</span>Burning activity calendar
            </h2>
            <span className="label dim">{calendar?.unit ?? ''} · per month</span>
          </div>
          <div className="chart-box">
            {calendar ? <Calendar data={calendar} /> : !error && <p className="loading">Loading calendar</p>}
          </div>
        </section>

        <footer className="cols footer label">
          <span className="mono">{scopeCode}</span>
          <span className="mono">
            <Clock />
          </span>
          <a className="btn" href={api.exportCsvUrl({})}>
            Download hotspots CSV
          </a>
        </footer>
      </main>
    </div>
  );
}
