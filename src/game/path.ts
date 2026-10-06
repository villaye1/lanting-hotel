import { CONFIG } from "./config.ts";
import { MAP_H, MAP_W, SPOT, WALK } from "./map.ts";
import type { Pt } from "./types.ts";

export type Who = "guest" | "staff" | "vehicle";

function pass(who: Who, cell: number): boolean {
  if (who === "vehicle") return cell === 3;
  if (who === "guest") return cell === 4 || cell === 1;
  return cell === 4 || cell === 1 || cell === 2;
}

function cell(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return 0;
  return WALK[y * MAP_W + x] ?? 0;
}

export function isWalk(x: number, y: number, who: Who): boolean {
  return pass(who, cell(x, y));
}

export function nearestWalkable(x: number, y: number, who: Who): Pt {
  const sx = Math.round(x);
  const sy = Math.round(y);
  if (isWalk(sx, sy, who)) return { x: sx, y: sy };
  for (let r = 1; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (isWalk(sx + dx, sy + dy, who)) return { x: sx + dx, y: sy + dy };
      }
    }
  }
  return { x: sx, y: sy };
}

const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export function findPath(sx: number, sy: number, gx: number, gy: number, who: Who): Pt[] {
  const start = nearestWalkable(Math.round(sx), Math.round(sy), who);
  const goal = nearestWalkable(Math.round(gx), Math.round(gy), who);
  if (start.x === goal.x && start.y === goal.y) return [];
  const key = (x: number, y: number) => y * MAP_W + x;
  const startK = key(start.x, start.y);
  const goalK = key(goal.x, goal.y);
  const open: number[] = [startK];
  const g = new Map<number, number>([[startK, 0]]);
  const prev = new Map<number, number>();
  const inOpen = new Set<number>([startK]);
  while (open.length) {
    let bestI = 0;
    let bestF = Infinity;
    for (let i = 0; i < open.length; i++) {
      const k = open[i]!;
      const gg = g.get(k) ?? 0;
      const x = k % MAP_W;
      const y = (k - x) / MAP_W;
      const f = gg + Math.abs(x - goal.x) + Math.abs(y - goal.y);
      if (f < bestF) {
        bestF = f;
        bestI = i;
      }
    }
    const cur = open.splice(bestI, 1)[0]!;
    inOpen.delete(cur);
    if (cur === goalK) {
      const path: Pt[] = [];
      let c: number | undefined = cur;
      while (c !== undefined && c !== startK) {
        path.push({ x: c % MAP_W, y: Math.floor(c / MAP_W) });
        c = prev.get(c);
      }
      path.reverse();
      return path;
    }
    const cx = cur % MAP_W;
    const cy = Math.floor(cur / MAP_W);
    const cg = g.get(cur) ?? 0;
    for (const d of DIRS) {
      const nx = cx + d.x;
      const ny = cy + d.y;
      if (!isWalk(nx, ny, who)) continue;
      const nk = key(nx, ny);
      const ng = cg + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        prev.set(nk, cur);
        if (!inOpen.has(nk)) {
          open.push(nk);
          inOpen.add(nk);
        }
      }
    }
  }
  return [];
}

export function pathMinutes(from: Pt, to: Pt, who: Who): number {
  const path = findPath(from.x, from.y, to.x, to.y, who);
  if (!path.length && (from.x !== to.x || from.y !== to.y)) return 30;
  const speed = who === "vehicle" ? CONFIG.speed.vehicle : who === "guest" ? CONFIG.speed.guest : CONFIG.speed.staff;
  return Math.max(1, Math.ceil(path.length / speed));
}

let tripCache: { depotToStation: number; stationToPorte: number; porteToStation: number } | null = null;

export function trips() {
  if (!tripCache) {
    tripCache = {
      depotToStation: pathMinutes(SPOT.depotVeh, SPOT.stationVeh, "vehicle"),
      stationToPorte: pathMinutes(SPOT.stationVeh, SPOT.porteVeh, "vehicle"),
      porteToStation: pathMinutes(SPOT.porteVeh, SPOT.stationVeh, "vehicle"),
    };
  }
  return tripCache;
}
