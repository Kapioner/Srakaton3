import { Crosshair, Radio } from 'lucide-react';
import type { LiveFire, LiveForecast, LiveMotion, LiveSituation, LiveStatus } from '../../../shared/api.ts';
import { LIVE_COLORS } from './FireMap.tsx';

interface Props {
  on: boolean;
  onToggle: (on: boolean) => void;
  status: LiveStatus | null;
  situation: LiveSituation | null;
  forecast: LiveForecast | null;
  loading: boolean;
  error: string | null;
  onFocus: (centroid: [number, number]) => void;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

function ago(iso: string | null | undefined): string {
  if (!iso) return '--';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function motionText(m: LiveMotion | undefined): string {
  if (!m) return 'no forecast';
  if (m.bearingDeg === null || m.speedKmh < 0.05) return 'stationary';
  return `→ ${compass(m.bearingDeg)} ${m.speedKmh.toFixed(1)} km/h`;
}

/**
 * "What burns now" next to the history: the largest active fires in the map view (FIRMS near-real-time,
 * last 24 h), how they move (trend of the last 48 h), and how fresh the feed is.
 */
export function LivePanel({ on, onToggle, status, situation, forecast, loading, error, onFocus }: Props) {
  // The situation clusters 24 h of detections, the forecast 48 h, so the same fire can get another id
  // (the id is its south-western cell). Match by id first, else by the nearest last observed position.
  const tracks: { motion: LiveMotion; last: number[] }[] = [];
  const motion = new Map<string, LiveMotion>();
  for (const f of forecast?.features ?? []) {
    if (f.properties.kind !== 'track' || f.geometry.type !== 'LineString') continue;
    motion.set(f.properties.clusterId, f.properties);
    const coords = f.geometry.coordinates;
    tracks.push({ motion: f.properties, last: coords[Math.max(0, f.properties.observedPoints - 1)] ?? coords[0] });
  }
  const motionFor = (fire: LiveFire): LiveMotion | undefined => {
    const byId = motion.get(fire.clusterId);
    if (byId) return byId;
    const [lon, lat] = fire.centroid;
    let best: { d: number; m: LiveMotion } | null = null;
    for (const t of tracks) {
      const dx = (t.last[0] - lon) * 111.32 * Math.cos((lat * Math.PI) / 180);
      const dy = (t.last[1] - lat) * 110.57;
      const d = Math.hypot(dx, dy);
      if (d < 25 && (!best || d < best.d)) best = { d, m: t.motion };
    }
    return best?.m;
  };
  const fires: LiveFire[] = (situation?.features ?? []).map((f) => f.properties).filter((p) => p.active);
  const top = fires.slice(0, 6);
  const feedOk = status?.lastRun?.status === 'ok';

  return (
    <div className="live-panel">
      <div className="live-head">
        <div className="segmented" role="group" aria-label="Live layer">
          <button type="button" aria-pressed={on} onClick={() => onToggle(true)}>
            <Radio size={14} /> Live on map
          </button>
          <button type="button" aria-pressed={!on} onClick={() => onToggle(false)}>
            History only
          </button>
        </div>
        <span className="live-feed mono dim">
          <span className="live-led" style={{ background: status ? (feedOk ? '#2ec4a0' : '#ffb020') : '#a39a9c' }} />
          FIRMS NRT · {status ? `${status.mode.mode}, checked ${ago(status.lastRun?.finishedAt)}` : 'checking the feed'}
        </span>
      </div>

      {on && (
        <>
          <p className="section-note">
            Fires detected in the last 24 h in the map view
            {situation ? ` · ${fires.length} active` : ''}. <span style={{ color: LIVE_COLORS.fire }}>■</span> current fire{' '}
            <span style={{ color: LIVE_COLORS.forecast }}>■</span> observed track and expected position in 6 / 12 / 24 h.
            Move or zoom the map to search elsewhere.
          </p>
          {error && <p className="error">Live: {error}</p>}
          {!error && loading && !situation && <p className="loading">Loading live fires</p>}
          {top.length > 0 && (
            <table className="live-table">
              <thead>
                <tr>
                  <th>Fire</th>
                  <th>Area</th>
                  <th>Max FRP</th>
                  <th>Movement</th>
                  <th>Last seen</th>
                  <th aria-label="Show on map" />
                </tr>
              </thead>
              <tbody>
                {top.map((f) => (
                  <tr key={f.clusterId}>
                    <td className="mono">
                      {f.centroid[1].toFixed(2)}, {f.centroid[0].toFixed(2)}
                    </td>
                    <td className="mono">~{f.approxAreaKm2} km²</td>
                    <td className="mono">{f.maxFrpMw} MW</td>
                    <td className="mono">
                      {motionText(motionFor(f))}
                      {motionFor(f) && <span className="dim"> · {motionFor(f)!.confidence}</span>}
                    </td>
                    <td className="mono dim">{ago(f.lastSeen)}</td>
                    <td>
                      <button type="button" className="qp-ghost" onClick={() => onFocus(f.centroid)} title="Show on map">
                        <Crosshair size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {situation && fires.length === 0 && !loading && <p className="section-note">No active fires in this view in the last 24 h.</p>}
          {forecast && <p className="section-note dim">Forecast: {forecast.metadata.disclaimer}</p>}
        </>
      )}
    </div>
  );
}
