// Watch locations: places an emergency manager pins on the map to follow (e.g. a town or a park).
// Stored in the browser only (localStorage); nothing is sent to the server.
import type { GridFeature } from '../../../shared/api.ts';

export interface WatchLocation {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  createdAt: string;
}

const STORAGE_KEY = 'firecal-watch-locations';

export function loadLocations(): WatchLocation[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    const parsed = data ? (JSON.parse(data) as WatchLocation[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocations(locations: WatchLocation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(locations));
  } catch {
    // Private mode or storage disabled: locations simply are not remembered.
  }
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Harmonized fire activity and raw detections in grid cells within `radiusKm` of a location. */
export function activityNear(loc: WatchLocation, features: GridFeature[], radiusKm = 25) {
  let h = 0;
  let detections = 0;
  let cells = 0;
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    if (distanceKm(loc.latitude, loc.longitude, lat, lon) <= radiusKm) {
      h += f.properties.h;
      detections += f.properties.detections;
      cells += 1;
    }
  }
  return { h, detections, cells, radiusKm };
}
