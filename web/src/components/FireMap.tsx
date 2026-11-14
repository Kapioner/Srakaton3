import { Crosshair, Globe2, Maximize2, Minus, Plus } from 'lucide-react';
import * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bbox, GridResponse, LiveForecast, LiveSituation } from '../../../shared/api.ts';
import type { WatchLocation } from '../features/locations.ts';
import { dataColors, fireRamp, theme } from '../theme.ts';

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

interface Props {
  grid: GridResponse | null;
  /** Area to fit the map to (the query region, or the dataset extent). */
  bbox: Bbox | null;
  /** The query region, drawn as an outline; null = whole dataset. */
  selection: Bbox | null;
  /** Called with the visible area after every pan/zoom ("use map view" in the query panel). */
  onViewChange?: (view: Bbox) => void;
  locations: WatchLocation[];
  selectedId: string | null;
  addMode: boolean;
  onAdd: (lngLat: { lng: number; lat: number }) => void;
  onSelect: (id: string) => void;
  /** Shifts the map controls left while the locations drawer covers the right edge. */
  drawerOpen?: boolean;
  /** Overlays rendered inside the map frame (the locations drawer and its toggle). */
  children?: ReactNode;
  /** Live layer (current fires + movement forecast); null = off. The historical grid is dimmed while it is on. */
  live?: { situation: LiveSituation | null; forecast: LiveForecast | null } | null;
  /** Fly to this point (e.g. a fire picked in the live list). */
  focus?: [lon: number, lat: number] | null;
}

/** Live fires: yellow, distinct from the red-to-gold history ramp; forecast: cyan. */
export const LIVE_COLORS = { fire: '#ffe14d', forecast: '#5ef2ff' };

/** MapLibre map: harmonized fire grid (fire ramp) + the user's watch locations (violet). */
export function FireMap({ grid, bbox, selection, onViewChange, locations, selectedId, addMode, onAdd, onSelect, drawerOpen, children, live: liveLayer, focus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  // Latest callbacks/flags for the long-lived map event handlers.
  const live = useRef({ addMode, onAdd, onSelect, onViewChange });
  live.current = { addMode, onAdd, onSelect, onViewChange };

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
      instance.addSource('selection', { type: 'geojson', data: EMPTY });
      instance.addLayer({
        id: 'selection',
        type: 'line',
        source: 'selection',
        paint: { 'line-color': theme.bone, 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.85 },
      });
      instance.addLayer({
        id: 'fires-glow',
        type: 'circle',
        source: 'fires',
        paint: {
          'circle-radius': glowFor(0.1),
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
          // Radius and colour stops depend on the data (cell size, max value): set in the grid effect below.
          'circle-radius': radiusFor(0.1),
          'circle-color': colourFor(4),
          'circle-opacity': 0.9,
          'circle-stroke-width': 0.5,
          'circle-stroke-color': theme.panel,
        },
      });
      // ---- live layer: forecast areas (6/12/24 h), observed + predicted tracks, current fire outlines ----
      instance.addSource('live-fires', { type: 'geojson', data: EMPTY });
      instance.addSource('live-points', { type: 'geojson', data: EMPTY });
      instance.addSource('live-forecast', { type: 'geojson', data: EMPTY });
      instance.addLayer({
        id: 'live-forecast-area',
        type: 'fill',
        source: 'live-forecast',
        filter: ['==', ['get', 'kind'], 'forecast_area'],
        paint: { 'fill-color': LIVE_COLORS.forecast, 'fill-opacity': ['interpolate', ['linear'], ['get', 'horizonHours'], 6, 0.16, 24, 0.05] },
      });
      instance.addLayer({
        id: 'live-forecast-outline',
        type: 'line',
        source: 'live-forecast',
        filter: ['==', ['get', 'kind'], 'forecast_area'],
        paint: { 'line-color': LIVE_COLORS.forecast, 'line-width': 1, 'line-dasharray': [2, 2], 'line-opacity': 0.55 },
      });
      instance.addLayer({
        id: 'live-track',
        type: 'line',
        source: 'live-forecast',
        filter: ['==', ['get', 'kind'], 'track'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': LIVE_COLORS.forecast, 'line-width': 2.5 },
      });
      instance.addLayer({
        id: 'live-fires-fill',
        type: 'fill',
        source: 'live-fires',
        paint: { 'fill-color': LIVE_COLORS.fire, 'fill-opacity': 0.35 },
      });
      instance.addLayer({
        id: 'live-fires-line',
        type: 'line',
        source: 'live-fires',
        paint: { 'line-color': LIVE_COLORS.fire, 'line-width': 1.5 },
      });
      // Fire polygons are a few km wide: a marker per fire keeps them visible on the world view.
      instance.addLayer({
        id: 'live-points',
        type: 'circle',
        source: 'live-points',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'approxAreaKm2']], 0, 3, 10, 8, 40, 16],
          'circle-color': LIVE_COLORS.fire,
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.9, 9, 0.15],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': theme.panel,
        },
      });

      instance.addLayer({
        id: 'locations-ring',
        type: 'circle',
        source: 'locations',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 16, 12],
          'circle-color': 'transparent',
          'circle-stroke-width': 2,
          'circle-stroke-color': dataColors.location,
        },
      });
      instance.addLayer({
        id: 'locations',
        type: 'circle',
        source: 'locations',
        paint: {
          'circle-radius': 6,
          'circle-color': dataColors.location,
          'circle-stroke-width': 2.5,
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
    for (const layer of ['locations', 'fires', 'live-points']) {
      instance.on('mouseenter', layer, () => {
        if (!live.current.addMode) instance.getCanvas().style.cursor = 'pointer';
      });
      instance.on('mouseleave', layer, () => {
        instance.getCanvas().style.cursor = live.current.addMode ? 'crosshair' : '';
      });
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
    instance.on('mousemove', 'live-points', (e) => {
      const p = e.features?.[0]?.properties as { approxAreaKm2: number; maxFrpMw: number; lastSeen: string; detections: number } | undefined;
      if (!p || live.current.addMode) return;
      const ago = Math.max(0, Math.round((Date.now() - Date.parse(p.lastSeen)) / 3_600_000));
      popup
        .setLngLat(e.lngLat)
        .setHTML(`<b>Active fire</b> · ~${p.approxAreaKm2} km²<br/>max FRP ${p.maxFrpMw} MW · ${p.detections} detections<br/>last seen ${ago} h ago`)
        .addTo(instance);
    });
    instance.on('mouseleave', 'live-points', () => popup.remove());
    const reportView = () => {
      const b = instance.getBounds();
      live.current.onViewChange?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => Math.round(v * 1000) / 1000) as Bbox);
    };
    instance.on('moveend', reportView);
    instance.once('idle', reportView);

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
    if (grid) {
      // Scale colours to this result (a 25-year total and a single week differ by orders of magnitude).
      const maxLn = Math.max(1, ...grid.features.map((f) => Math.log(1 + f.properties.h)));
      m.setPaintProperty('fires', 'circle-color', colourFor(maxLn));
      m.setPaintProperty('fires', 'circle-radius', radiusFor(grid.query.res));
      m.setPaintProperty('fires-glow', 'circle-radius', glowFor(grid.query.res));
    }
  }, [grid, ready]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    (m.getSource('selection') as maplibregl.GeoJSONSource).setData(
      selection
        ? {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [selection[0], selection[1]],
                [selection[2], selection[1]],
                [selection[2], selection[3]],
                [selection[0], selection[3]],
                [selection[0], selection[1]],
              ],
            },
          }
        : EMPTY,
    );
  }, [selection, ready]);

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
    if (bbox) map.current?.fitBounds([bbox[0], bbox[1], bbox[2], bbox[3]], { padding: 40, duration: 600, maxZoom: 9 });
    // Re-fit only when the numbers change, not on every new array instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox?.join(',')]);

  useEffect(() => {
    const loc = locations.find((l) => l.id === selectedId);
    const m = map.current;
    if (loc && m && !m.getBounds().contains([loc.longitude, loc.latitude])) {
      m.flyTo({ center: [loc.longitude, loc.latitude], duration: 900 });
    }
    // Fly only when the selection changes, not when other locations are edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    (m.getSource('live-fires') as maplibregl.GeoJSONSource).setData((liveLayer?.situation as unknown as FeatureCollection) ?? EMPTY);
    (m.getSource('live-points') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (liveLayer?.situation?.features ?? []).map((f) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: f.properties.centroid },
        properties: f.properties as unknown as Record<string, unknown>,
      })),
    });
    (m.getSource('live-forecast') as maplibregl.GeoJSONSource).setData((liveLayer?.forecast as unknown as FeatureCollection) ?? EMPTY);
    // History steps back while the live picture is shown, and coarse cells (1 deg on the world view) fade out
    // once they are bigger than ~40 px on screen, so they do not cover the fires the live layer zooms to.
    const res = grid?.query.res ?? 0.1;
    const fadeZoom = Math.log2(40 / (0.45 * res * (512 / 360)));
    const dimmed: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], fadeZoom, 0.3, fadeZoom + 1, 0];
    m.setPaintProperty('fires', 'circle-opacity', liveLayer ? dimmed : addMode ? 0.25 : 0.9);
    m.setPaintProperty('fires-glow', 'circle-opacity', liveLayer || addMode ? 0.03 : 0.12);
  }, [liveLayer, ready, addMode, grid]);

  useEffect(() => {
    if (focus) map.current?.flyTo({ center: focus, zoom: Math.max(map.current.getZoom(), 8), duration: 900 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.join(',')]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.getCanvas().style.cursor = addMode ? 'crosshair' : '';
  }, [addMode]);

  const resetView = () => {
    if (bbox) map.current?.fitBounds([bbox[0], bbox[1], bbox[2], bbox[3]], { padding: 40, duration: 900 });
  };

  return (
    <div className={`map-container ${drawerOpen ? 'drawer-open' : ''}`}>
      <div ref={container} className="map-canvas" />

      <div className="map-overlay top">
        <span className="map-tag">
          <span className="live-dot" />
          Fire grid · {grid ? `${grid.query.from} → ${grid.query.to}` : 'loading'}
        </span>
        <span className="map-tag ghost mono">
          {grid ? `${grid.features.length} cells · ${grid.query.res}°${grid.truncated ? ' · strongest only' : ''}` : ''}
        </span>
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

      {children}

      <div className="map-legend" aria-label="Map legend">
        <span className="label">Fire cell-days</span>
        <span className="ramp" />
        <span className="mono">low → high</span>
        <span className="legend-dot" /> <span>watch location</span>
      </div>
    </div>
  );
}

/** Circle colour on ln(1 + h), stretched over this result's range on the fire ramp. */
function colourFor(maxLn: number): maplibregl.ExpressionSpecification {
  const stops = fireRamp.slice(2); // skip the near-black end: dots must stand out on the dark basemap
  const expr: unknown[] = ['interpolate', ['linear'], ['ln', ['+', 1, ['get', 'h']]]];
  stops.forEach((c, i) => expr.push((maxLn * i) / (stops.length - 1), c));
  return expr as maplibregl.ExpressionSpecification;
}

/**
 * Circle radius by zoom = the cell's real size on screen, so dots never overlap however coarse the grid is
 * (the server coarsens big regions to 0.25-1 deg). Web Mercator at zoom z: 512 * 2^z px per 360 deg.
 * `fill` < 0.5 leaves a hairline gap between neighbouring cells; `min` keeps tiny cells visible.
 */
function cellRadius(res: number, fill: number, min: number): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ['interpolate', ['exponential', 2], ['zoom']];
  for (let z = 0; z <= 14; z++) expr.push(z, Math.max(min, fill * res * (512 / 360) * 2 ** z));
  return expr as maplibregl.ExpressionSpecification;
}

function radiusFor(res: number): maplibregl.ExpressionSpecification {
  return cellRadius(res, 0.45, 1.2);
}

/** Soft halo around each cell, a little wider than the cell itself. */
function glowFor(res: number): maplibregl.ExpressionSpecification {
  return cellRadius(res, 1.1, 2.5);
}
