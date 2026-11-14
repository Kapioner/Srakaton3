import { Crop, RotateCcw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Bbox, MetaResponse, Region } from '../../../shared/api.ts';

/** The applied search. `label` names the region for people ("Greece", "Map view", "All data"). */
export interface Query {
  bbox: Bbox | null;
  from: string | null;
  to: string | null;
  label: string;
}

export const ALL_DATA: Query = { bbox: null, from: null, to: null, label: 'All data' };

interface Props {
  meta: MetaResponse | null;
  regions: Region[];
  query: Query;
  /** Current visible map area, for "use map view". */
  mapView: Bbox | null;
  busy: boolean;
  onApply: (q: Query) => void;
}

const fmtBbox = (b: Bbox) => b.map((v) => v.toFixed(2)).join(', ');

/**
 * Region + date range search. Nothing is fetched until Apply, so editing several fields
 * does not fire several heavy queries (important on the world dataset).
 */
export function QueryPanel({ meta, regions, query, mapView, busy, onApply }: Props) {
  const [region, setRegion] = useState<string>(query.label);
  const [bbox, setBbox] = useState<Bbox | null>(query.bbox);
  const [from, setFrom] = useState(query.from ?? '');
  const [to, setTo] = useState(query.to ?? '');

  // Keep the form in sync when the query changes from outside (e.g. Reset).
  useEffect(() => {
    setRegion(query.label);
    setBbox(query.bbox);
    setFrom(query.from ?? '');
    setTo(query.to ?? '');
  }, [query]);

  const min = meta?.dateRange.from ?? '';
  const max = meta?.dateRange.to ?? '';
  const lastYear = max ? Number(max.slice(0, 4)) : null;
  const presets: { label: string; from: string; to: string }[] = lastYear
    ? [
        { label: 'All years', from: '', to: '' },
        { label: String(lastYear), from: `${lastYear}-01-01`, to: `${lastYear}-12-31` },
        { label: `Summer ${lastYear}`, from: `${lastYear}-06-01`, to: `${lastYear}-09-30` },
        { label: 'Aug 2023', from: '2023-08-01', to: '2023-08-31' },
      ]
    : [];

  const pickRegion = (value: string) => {
    setRegion(value);
    if (value === ALL_DATA.label) setBbox(null);
    else if (value === 'Map view') setBbox(mapView);
    else setBbox(regions.find((r) => r.country === value)?.bbox ?? null);
  };

  const useMapView = () => {
    if (!mapView) return;
    setRegion('Map view');
    setBbox(mapView);
  };

  const invalidDates = Boolean(from && to && from > to);
  const apply = () => onApply({ bbox, from: from || null, to: to || null, label: region });

  return (
    <form
      className="query-panel"
      aria-label="Search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalidDates) apply();
      }}
    >
      <div className="qp-field">
        <label className="label dim" htmlFor="qp-region">
          Region
        </label>
        <div className="qp-row">
          <select id="qp-region" value={region} onChange={(e) => pickRegion(e.target.value)}>
            <option>{ALL_DATA.label}</option>
            {regions.map((r) => (
              <option key={r.country}>{r.country}</option>
            ))}
            {region !== ALL_DATA.label && !regions.some((r) => r.country === region) && <option>{region}</option>}
          </select>
          <button type="button" className="qp-ghost" onClick={useMapView} disabled={!mapView} title="Search the area visible on the map">
            <Crop size={15} />
            Map view
          </button>
        </div>
        <span className="qp-hint mono">{bbox ? fmtBbox(bbox) : 'whole dataset'}</span>
      </div>

      <div className="qp-field">
        <span className="label dim">Dates</span>
        <div className="qp-row">
          <input type="date" aria-label="From" value={from} min={min} max={max} onChange={(e) => setFrom(e.target.value)} />
          <span className="dim">→</span>
          <input type="date" aria-label="To" value={to} min={min} max={max} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="qp-presets">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              aria-pressed={from === p.from && to === p.to}
              onClick={() => {
                setFrom(p.from);
                setTo(p.to);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {invalidDates && <span className="qp-error">"From" is after "To"</span>}
      </div>

      <div className="qp-actions">
        <button type="submit" className="qp-apply" disabled={busy || invalidDates}>
          <Search size={15} />
          {busy ? 'Loading' : 'Apply'}
        </button>
        <button type="button" className="qp-ghost" onClick={() => onApply(ALL_DATA)} title="Back to all data">
          <RotateCcw size={15} />
          Reset
        </button>
      </div>
    </form>
  );
}
