import { useEffect, useState } from 'react';
import type { CalendarResponse, MetaResponse } from '../../shared/api.ts';
import { api } from './api.ts';
import { Calendar } from './components/Calendar.tsx';

// Stage 0 smoke test: proves web -> API -> data works end to end.
// Stage 4 replaces this with the full layout from docs/PLAN.md (map, insight, charts).
export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [calendar, setCalendar] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.meta(), api.calendar({})])
      .then(([m, c]) => {
        setMeta(m);
        setCalendar(c);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <header>
        <h1>Burning Activity Calendar</h1>
        {meta && (
          <span className="muted">
            {meta.countries.join(', ')} · {meta.dateRange.from} to {meta.dateRange.to} ·{' '}
            {meta.sensors.map((s) => s.id).join(' + ')}
          </span>
        )}
        <a href={api.exportCsvUrl({})}>Download CSV</a>
      </header>

      {error && <p className="error">API error: {error}. Is the server running on port 3001?</p>}

      <section className="panel">
        <h2>Harmonized fire activity (MODIS-equivalent active cells per month)</h2>
        {calendar ? <Calendar data={calendar} /> : !error && <p className="muted">Loading…</p>}
      </section>
    </div>
  );
}
