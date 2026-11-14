import type { Detection } from '../repository.js';

/** Detections that belong to one fire: connected through neighbouring grid cells. */
export interface FireCluster {
  id: string;
  detections: Detection[];
  /** Number of distinct active grid cells: the harmonized, sensor-independent size measure. */
  activeCells: number;
}

/**
 * Groups detections into fires. Two active cells belong to the same fire when they are at most
 * `linkCells` cells apart, which bridges the gaps between MODIS (1 km) and VIIRS (375 m) footprints.
 * Union-find over a hash of occupied cells: O(cells × neighbourhood).
 */
export function clusterDetections(detections: Detection[], linkCells = 2): FireCluster[] {
  const key = (x: number, y: number) => `${x}:${y}`;
  const cells = new Map<string, { x: number; y: number; members: Detection[] }>();
  for (const d of detections) {
    const k = key(d.cellX, d.cellY);
    let cell = cells.get(k);
    if (!cell) cells.set(k, (cell = { x: d.cellX, y: d.cellY, members: [] }));
    cell.members.push(d);
  }

  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = k; node !== root; ) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const k of cells.keys()) parent.set(k, k);
  for (const [k, cell] of cells) {
    for (let dx = -linkCells; dx <= linkCells; dx++) {
      for (let dy = -linkCells; dy <= linkCells; dy++) {
        const neighbour = key(cell.x + dx, cell.y + dy);
        if (neighbour !== k && cells.has(neighbour)) parent.set(find(k), find(neighbour));
      }
    }
  }

  const groups = new Map<string, { detections: Detection[]; cells: { x: number; y: number }[] }>();
  for (const [k, cell] of cells) {
    const root = find(k);
    let group = groups.get(root);
    if (!group) groups.set(root, (group = { detections: [], cells: [] }));
    group.detections.push(...cell.members);
    group.cells.push(cell);
  }

  return [...groups.values()].map((group) => {
    // The south-western cell gives an id that stays stable while the fire keeps its origin.
    const anchor = group.cells.reduce((a, b) => (b.x < a.x || (b.x === a.x && b.y < a.y) ? b : a));
    return { id: `${anchor.x}_${anchor.y}`, detections: group.detections, activeCells: group.cells.length };
  });
}
