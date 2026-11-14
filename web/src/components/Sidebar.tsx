import { Activity, CalendarDays, FileBarChart, FlaskConical, Map as MapIcon } from 'lucide-react';
import type { MetaResponse } from '../../../shared/api.ts';
import { dataColors } from '../theme.ts';
import { Clock } from './Clock.tsx';

interface Props {
  meta: MetaResponse | null;
  gridCells: number;
  locations: number;
  scopeCode: string;
}

const NAV = [
  { href: '#map', label: 'Map', icon: MapIcon },
  { href: '#calendar', label: 'Calendar', icon: CalendarDays },
  { href: '#series', label: 'Sensors', icon: Activity },
  { href: '#report', label: 'Report', icon: FileBarChart },
  { href: '#method', label: 'Method', icon: FlaskConical },
];

/** Left sidebar: brand, section links, map layers and the data scope. */
export function Sidebar({ meta, gridCells, locations, scopeCode }: Props) {
  return (
    <aside className="sidebar">
      <a className="brand" href="#top">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-word">Firecal</span>
      </a>

      <nav className="sidebar-section" aria-label="Sections">
        <div className="label dim section-label">Workspace</div>
        {NAV.map(({ href, label, icon: Icon }) => (
          <a key={href} className="nav-item" href={href}>
            <Icon size={16} />
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <div className="sidebar-section">
        <div className="label dim section-label">Map layers</div>
        <div className="layer-item">
          <span className="layer-swatch fire" />
          <span>Fire grid</span>
          <span className="layer-count mono">{gridCells}</span>
        </div>
        <div className="layer-item">
          <span className="layer-swatch" style={{ background: dataColors.location }} />
          <span>Watch locations</span>
          <span className="layer-count mono">{locations}</span>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="label dim section-label">Satellites</div>
        {meta?.satellites.map((s) => (
          <div key={s.satellite} className="layer-item satellite">
            <span className="layer-swatch" style={{ background: dataColors.satellites[s.satellite] ?? dataColors.raw }} />
            <span className="sat-text">
              <span>
                {s.satellite} <span className="dim">· {s.sensor}</span>
              </span>
              <span className="sat-since mono">Introduced in {s.from.slice(0, 4)}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <div className="scope-card">
          <span className="label dim">Scope</span>
          <strong className="mono">{scopeCode}</strong>
          <span className="mono dim">
            <Clock />
          </span>
        </div>
      </div>
    </aside>
  );
}
