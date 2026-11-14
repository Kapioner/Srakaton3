import { MapPin, Plus, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { GridResponse } from '../../../shared/api.ts';
import { activityNear, type WatchLocation } from '../features/locations.ts';

interface Props {
  locations: WatchLocation[];
  selectedId: string | null;
  addMode: boolean;
  grid: GridResponse | null;
  onToggleAdd: () => void;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Right panel: the user's watch locations with fire activity around each one. */
export function LocationsPanel({ locations, selectedId, addMode, grid, onToggleAdd, onSelect, onRemove }: Props) {
  const [search, setSearch] = useState('');
  const filtered = locations.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()));
  const selected = locations.find((l) => l.id === selectedId) ?? null;
  const near = selected && grid ? activityNear(selected, grid.features) : null;

  return (
    <aside className="right-panel" aria-label="Watch locations">
      <div className="panel-header">
        <div>
          <div className="label dim">Watch list</div>
          <h2>Locations</h2>
        </div>
        <span className="panel-count mono">{String(locations.length).padStart(2, '0')}</span>
      </div>

      <button type="button" className={`add-button ${addMode ? 'adding' : ''}`} onClick={onToggleAdd}>
        {addMode ? <X size={16} /> : <Plus size={16} />}
        {addMode ? 'Cancel adding' : 'Add location'}
      </button>

      <label className="search-box">
        <Search size={15} />
        <input placeholder="Search locations" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>

      <div className="panel-list-header label">
        <span>All locations</span>
        <span>Newest first</span>
      </div>

      <div className="points-list">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <MapPin size={22} />
            <strong>No locations yet</strong>
            <p>Add a town, a park or a road you want to keep an eye on, then click its spot on the map.</p>
          </div>
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
