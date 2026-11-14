// SIMULATED "AI land-cover" module: a stand-in for a classifier that would read satellite imagery around
// each fire and tell what is burning (town, forest, shrubland, cropland). No model runs here: the class is
// derived deterministically from the fire's position, so the same fire always gets the same answer.
// Every result carries `simulated: true`, and the UI labels it as a prototype.
import type { LonLat } from './geo.js';

export type LandCoverClass = 'urban' | 'forest' | 'shrubland' | 'cropland';
export type AlertLevel = 'ALARM' | 'WARNING' | 'WATCH' | 'MONITOR';

export interface LandCover {
  class: LandCoverClass;
  label: string;
  /** Classifier confidence shown in the UI (simulated). */
  confidence: number;
  alert: AlertLevel;
  simulated: true;
}

const CLASSES: { class: LandCoverClass; label: string; alert: AlertLevel; weight: number }[] = [
  { class: 'urban', label: 'Urban area', alert: 'ALARM', weight: 0.12 },
  { class: 'forest', label: 'Forest', alert: 'WARNING', weight: 0.36 },
  { class: 'shrubland', label: 'Shrubland', alert: 'WATCH', weight: 0.24 },
  { class: 'cropland', label: 'Cropland', alert: 'MONITOR', weight: 0.28 },
];

/** Small deterministic hash of a 0.05 deg cell → [0, 1). */
function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

export function simulateLandCover([lon, lat]: LonLat): LandCover {
  const cell = `${Math.round(lat * 20)},${Math.round(lon * 20)}`;
  const u = unit(cell);
  let acc = 0;
  const pick = CLASSES.find((c) => (acc += c.weight) > u) ?? CLASSES[CLASSES.length - 1];
  const confidence = Math.round((0.72 + unit(`${cell}:c`) * 0.25) * 100) / 100;
  return { class: pick.class, label: pick.label, confidence, alert: pick.alert, simulated: true };
}
