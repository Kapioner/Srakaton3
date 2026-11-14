import { Crosshair, Globe2, Maximize2, Minus, Plus } from 'lucide-react';
import * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { useEffect, useRef, useState } from 'react';
import type { Bbox, GridResponse } from '../../../shared/api.ts';
import type { WatchLocation } from '../features/locations.ts';
import { dataColors, fireRamp, theme } from '../theme.ts';

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

interface Props {
  grid: GridResponse | null;
  bbox: Bbox | null;
  locations: WatchLocation[];
  selectedId: string | null;
  addMode: boolean;
  onAdd: (lngLat: { lng: number; lat: number }) => void;
  onSelect: (id: string) => void;
}

/** MapLibre map: harmonized fire grid (fire ramp) + the user's watch locations (violet). */
export function FireMap({ grid, bbox, locations, selectedId, addMode, onAdd, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  // Latest callbacks/flags for the long-lived map event handlers.
  const live = useRef({ addMode, onAdd, onSelect });
  live.current = { addMode, onAdd, onSelect };

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: BASEMAP,
      center: [23.5, 38.5],
      zoom: 5,
      minZoom: 1,
      maxZoom: 14,
      attributionControl: { compact: true },
      // The map sits in a long page: plain scrolling scrolls the page, Ctrl/Cmd + scroll zooms the map.
      cooperativeGestures: true,
    });
    map.current = instance;

    instance.on('load', () => {
      instance.addSource('fires', { type: 'geojson', data: EMPTY });
      instance.addSource('locations', { type: 'geojson', data: EMPTY });
      const maxH = ['ln', ['+', 1, ['get', 'h']]] as unknown as maplibregl.ExpressionSpecification;
      instance.addLayer({
        id: 'fires-glow',
        type: 'circle',
        source: 'fires',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 8, 22],
          'circle-color': theme.red,
          'circle-opacity': 0.12,
          'circle-blur': 0.9,
        },
      });
      instance.addLayer({
        id: 'fires',
        type: 'circle',
        source: 'fires',
        paint: {
          // 0.1 deg cells; colour by ln(1 + h) on the same fire ramp as the calendar.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 6, 5, 8, 11, 10, 26],
          'circle-color': [
            'interpolate',
            ['linear'],
            maxH,
            0, fireRamp[2],
            0.5, fireRamp[3],
            1, fireRamp[4],
            2, fireRamp[5],
            3, fireRamp[6],
            4, fireRamp[7],
          ],
          'circle-opacity': 0.9,
          'circle-stroke-width': 0.5,
          'circle-stroke-color': theme.panel,
        },
      });
      instance.addLayer({
        id: 'locations-ring',
        type: 'circle',
        source: 'locations',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 14, 10],
          'circle-color': 'transparent',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': dataColors.location,
        },
      });
      instance.addLayer({
        id: 'locations',
        type: 'circle',
        source: 'locations',
        paint: {
          'circle-radius': 4.5,
          'circle-color': dataColors.location,
          'circle-stroke-width': 2,
          'circle-stroke-color': theme.bone,
        },
      });
      setReady(true);
    });

    instance.on('click', 'locations', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id && !live.current.addMode) live.current.onSelect(String(id));
    });
    instance.on('click', (e) => {
      if (live.current.addMode) live.current.onAdd(e.lngLat);
    });
    for (const layer of ['locations', 'fires']) {
      instance.on('mouseenter', layer, () => (instance.getCanvas().style.cursor = 'pointer'));
      instance.on('mouseleave', layer, () => (instance.getCanvas().style.cursor = ''));
    }
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'fire-popup', offset: 10 });
    instance.on('mousemove', 'fires', (e) => {
      const f = e.features?.[0];
      if (!f || live.current.addMode) return;
      const p = f.properties as { h: number; detections: number; activeDays: number };
      popup
        .setLngLat(e.lngLat)
        .setHTML(`<b>${Number(p.h).toFixed(1)}</b> fire cell-days<br/>${p.detections} detections · ${p.activeDays} days`)
        .addTo(instance);
    });
    instance.on('mouseleave', 'fires', () => popup.remove());

    return () => {
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  // Push data into the map sources once the style is loaded.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    (m.getSource('fires') as maplibregl.GeoJSONSource).setData((grid as unknown as FeatureCollection) ?? EMPTY);
  }, [grid, ready]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    (m.getSource('locations') as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: locations.map((l) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [l.longitude, l.latitude] },
          properties: { id: l.id, selected: l.id === selectedId },
        })),
      });
  }, [locations, selectedId, ready]);

  useEffect(() => {
    if (bbox) map.current?.fitBounds([bbox[0], bbox[1], bbox[2], bbox[3]], { padding: 40, duration: 0 });
  }, [bbox]);

  useEffect(() => {
    const loc = locations.find((l) => l.id === selectedId);
    if (loc) map.current?.flyTo({ center: [loc.longitude, loc.latitude], zoom: Math.max(map.current.getZoom(), 8), duration: 900 });
    // Fly only when the selection changes, not when other locations are edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    const canvas = map.current?.getCanvas();
    if (canvas) canvas.style.cursor = addMode ? 'crosshair' : '';
  }, [addMode]);

  const resetView = () => {
    if (bbox) map.current?.fitBounds([bbox[0], bbox[1], bbox[2], bbox[3]], { padding: 40, duration: 900 });
  };

  return (
    <div className="map-container">
      <div ref={container} className="map-canvas" />

      <div className="map-overlay top">
        <span className="map-tag">
          <span className="live-dot" />
          Fire grid · {grid ? `${grid.query.from} → ${grid.query.to}` : 'loading'}
        </span>
        <span className="map-tag ghost mono">{grid ? `${grid.features.length} cells · ${grid.query.res}°` : ''}</span>
      </div>

      {addMode && (
        <div className="map-instruction">
          <Crosshair size={16} />
          Click on the map to add a watch location
        </div>
      )}

      <div className="map-controls">
        <button type="button" onClick={() => map.current?.zoomIn()} title="Zoom in" aria-label="Zoom in">
          <Plus size={17} />
        </button>
        <button type="button" onClick={() => map.current?.zoomOut()} title="Zoom out" aria-label="Zoom out">
          <Minus size={17} />
        </button>
        <span className="control-divider" />
        <button type="button" onClick={resetView} title="Fit region" aria-label="Fit region">
          <Maximize2 size={16} />
        </button>
        <button type="button" onClick={() => map.current?.flyTo({ center: [15, 25], zoom: 1.6, duration: 900 })} title="World view" aria-label="World view">
          <Globe2 size={16} />
        </button>
      </div>

      <div className="map-legend" aria-label="Map legend">
        <span className="label">Fire cell-days</span>
        <span className="ramp" />
        <span className="mono">low → high</span>
        <span className="legend-dot" /> <span>watch location</span>
      </div>
    </div>
  );
}
