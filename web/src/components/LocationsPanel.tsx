import { MapPin, Plus, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { GridResponse } from '../../../shared/api.ts';
import { activityNear, type WatchLocation } from '../features/locations.ts';

interface Props {
  open: boolean;
  locations: WatchLocation[];
  selectedId: string | null;
  addMode: boolean;
  grid: GridResponse | null;
  onClose: () => void;
  onToggleAdd: () => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Slide-out drawer over the map: the user's watch locations with fire activity around each one. */
export function LocationsPanel({ open, locations, selectedId, addMode, grid, onClose, onToggleAdd, onSelect, onRemove }: Props) {
  const [search, setSearch] = useState('');
  const filtered = locations.filter((l) => l.name.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = locations.find((l) => l.id === selectedId) ?? null;
  const near = selected && grid ? activityNear(selected, grid.features) : null;

  return (
    <aside className={`drawer ${open ? 'open' : ''}`} aria-label="Watch locations" aria-hidden={!open} inert={!open}>
      <div className="panel-header">
        <div>
          <div className="label dim">Watch list</div>
          <h2>Locations</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Hide locations">
          <X size={17} />
        </button>
      </div>

      <button type="button" className={`add-button ${addMode ? 'adding' : ''}`} onClick={onToggleAdd}>
        {addMode ? <X size={16} /> : <Plus size={16} />}
        {addMode ? 'Cancel adding (Esc)' : 'Add location'}
      </button>
      {addMode && <p className="drawer-hint">Click anywhere on the map. Fire dots are dimmed while you pick.</p>}

      {locations.length > 0 && (
        <label className="search-box">
          <Search size={15} />
          <input placeholder="Search locations" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      )}

      <div className="points-list">
        {locations.length === 0 ? (
          <div className="empty-state">
            <MapPin size={22} />
            <strong>No locations yet</strong>
            <p>Add a town, a park or a road you want to keep an eye on, then click its spot on the map.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="drawer-hint">No location matches “{search}”.</p>
        ) : (
          [...filtered].reverse().map((l) => (
            <div
              key={l.id}
              role="button"
              tabIndex={0}
              className={`point-card ${selectedId === l.id ? 'selected' : ''}`}
              onClick={() => onSelect(l.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(l.id)}
            >
              <MapPin size={16} className="point-icon" />
              <div className="point-info">
                <strong>{l.name}</strong>
                <span className="mono">
                  {l.latitude.toFixed(3)}, {l.longitude.toFixed(3)}
                </span>
              </div>
              <button
                type="button"
                className="delete-point"
                title="Delete location"
                aria-label={`Delete ${l.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(l.id);
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        )}
      </div>

      {selected && (
        <div className="details-panel">
          <div className="details-heading label">
            <span>Selected location</span>
            <button type="button" className="icon-button" onClick={() => onSelect(null)} aria-label="Close details">
              <X size={15} />
            </button>
          </div>
          <h3>{selected.name}</h3>
          <div className="coordinate-row">
            <span className="label">Lat / Lon</span>
            <strong className="mono">
              {selected.latitude.toFixed(4)}, {selected.longitude.toFixed(4)}
            </strong>
          </div>
          {near && (
            <>
              <div className="coordinate-row">
                <span className="label">Fire cell-days ≤ {near.radiusKm} km</span>
                <strong className="mono accent">{nf.format(near.h)}</strong>
              </div>
              <div className="coordinate-row">
                <span className="label">Detections ≤ {near.radiusKm} km</span>
                <strong className="mono">{near.detections}</strong>
              </div>
              <p className="details-note">
                In the map period {grid?.query.from} → {grid?.query.to}.
              </p>
            </>
          )}
        </div>
      )}

      <div className="panel-bottom label">
        <span className="panel-bottom-dot" />
        Saved in this browser
      </div>
    </aside>
  );
}
