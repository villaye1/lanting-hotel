import type { RoomType } from "./config.ts";
import type { Pt } from "./types.ts";

export const MAP_W = 48;
export const MAP_H = 32;
export const TILE_W = 32;
export const TILE_H = 16;

export type Floor = "grass" | "stone" | "carpet" | "wood" | "tile" | "road" | "court";

export interface RoomGeom {
  id: string;
  type: RoomType;
  capacity: number;
  x: number;
  y: number;
  w: number;
  h: number;
  door: Pt;
  inside: Pt;
  beds: Pt[];
  bath: Pt;
  lamp: Pt;
  window: Pt;
}

export interface Prop {
  kind: "bed" | "twin" | "bath" | "desk" | "sofa" | "table" | "plant" | "lamp" | "cart" | "shelf" | "counter" | "canopy";
  x: number;
  y: number;
  roomId?: string;
}

const floor = new Array<Floor>(MAP_W * MAP_H).fill("grass");
const walk = new Uint8Array(MAP_W * MAP_H);

function idx(x: number, y: number): number {
  return y * MAP_W + x;
}

function set(x: number, y: number, f: Floor, w: number) {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return;
  floor[idx(x, y)] = f;
  walk[idx(x, y)] = w;
}

function rect(x: number, y: number, w: number, h: number, f: Floor, wk: number) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, f, wk);
}

const SPECS: { id: string; type: RoomType; capacity: number; x: number; w: number }[] = [
  { id: "107", type: "suite", capacity: 3, x: 0, w: 8 },
  { id: "108", type: "suite", capacity: 3, x: 8, w: 8 },
  { id: "101", type: "king", capacity: 2, x: 16, w: 5 },
  { id: "102", type: "king", capacity: 2, x: 21, w: 5 },
  { id: "103", type: "king", capacity: 2, x: 26, w: 5 },
  { id: "104", type: "king", capacity: 2, x: 31, w: 5 },
  { id: "105", type: "twin", capacity: 2, x: 36, w: 6 },
  { id: "106", type: "twin", capacity: 2, x: 42, w: 6 },
];

function buildRooms(): RoomGeom[] {
  return SPECS.map((spec) => {
    const y = 1;
    const h = 6;
    const cx = spec.x + Math.floor(spec.w / 2);
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = spec.x; xx < spec.x + spec.w; xx++) {
        const edge = xx === spec.x || xx === spec.x + spec.w - 1 || yy === y || yy === y + h - 1;
        const door = xx === cx && yy === y + h - 1;
        if (edge && !door) set(xx, yy, "stone", 0);
        else set(xx, yy, "carpet", 4);
      }
    }
    const bath = { x: spec.x + spec.w - 2, y: 4 };
    if (bath.x !== cx) set(bath.x, bath.y, "tile", 0);
    const beds: Pt[] =
      spec.type === "twin"
        ? [
            { x: spec.x + 1, y: 2 },
            { x: spec.x + spec.w - 3, y: 2 },
          ]
        : [{ x: Math.max(spec.x + 1, cx - 1), y: 2 }];
    for (const b of beds) {
      if (b.x !== cx) set(b.x, b.y, "carpet", 0);
    }
    return {
      id: spec.id,
      type: spec.type,
      capacity: spec.capacity,
      x: spec.x,
      y,
      w: spec.w,
      h,
      door: { x: cx, y: y + h - 1 },
      inside: { x: cx, y: 4 },
      beds,
      bath,
      lamp: { x: cx + (cx < spec.x + spec.w - 2 ? 1 : -1), y: 3 },
      window: { x: cx, y: y },
    };
  });
}

rect(0, 7, MAP_W, 1, "carpet", 4);

rect(0, 8, 13, 2, "tile", 2);
rect(15, 8, 18, 2, "stone", 4);
rect(35, 8, 8, 2, "wood", 4);
rect(43, 8, 5, 2, "tile", 2);

rect(0, 10, 13, 7, "tile", 2);
rect(15, 10, 18, 7, "stone", 4);
rect(35, 10, 13, 7, "wood", 4);
rect(33, 12, 2, 3, "wood", 4);

set(24, 17, "court", 4);
rect(18, 18, 13, 7, "court", 4);
rect(0, 19, 13, 5, "tile", 2);
rect(35, 19, 13, 5, "tile", 2);
rect(4, 17, 5, 2, "tile", 2);
rect(40, 17, 3, 2, "tile", 2);

rect(0, 25, MAP_W, 1, "court", 4);
rect(0, 27, MAP_W, 1, "road", 3);

export const ROOMS: RoomGeom[] = buildRooms();
export const WALK = walk;
export const FLOOR = floor;

export const SPOT = {
  stationGuest: { x: 4, y: 25 },
  stationVeh: { x: 4, y: 27 },
  porteGuest: { x: 24, y: 25 },
  porteVeh: { x: 24, y: 27 },
  depotVeh: { x: 44, y: 27 },
  depotStaff: { x: 44, y: 25 },
  door: { x: 24, y: 17 },
  deskGuest: { x: 22, y: 14 },
  deskStaff: { x: 18, y: 14 },
  bell: { x: 24, y: 20 },
  luggage: { x: 16, y: 15 },
  concierge: { x: 30, y: 13 },
  restaurant: { x: 39, y: 13 },
  kitchen: { x: 40, y: 21 },
  laundry: { x: 6, y: 13 },
  staffRoom: { x: 6, y: 21 },
  lobby: { x: 24, y: 14 },
} as const;

export function roomById(id: string): RoomGeom {
  const r = ROOMS.find((room) => room.id === id);
  if (!r) throw new Error(`未知房间 ${id}`);
  return r;
}

export const PROPS: Prop[] = [
  { kind: "counter", x: 18, y: 13 },
  { kind: "desk", x: 30, y: 13 },
  { kind: "shelf", x: 16, y: 15 },
  { kind: "sofa", x: 26, y: 15 },
  { kind: "sofa", x: 21, y: 16 },
  { kind: "plant", x: 16, y: 12 },
  { kind: "plant", x: 31, y: 16 },
  { kind: "plant", x: 36, y: 16 },
  { kind: "table", x: 38, y: 12 },
  { kind: "table", x: 42, y: 14 },
  { kind: "table", x: 39, y: 15 },
  { kind: "counter", x: 44, y: 21 },
  { kind: "cart", x: 23, y: 21 },
  { kind: "lamp", x: 20, y: 15 },
  { kind: "canopy", x: 20, y: 22 },
  { kind: "canopy", x: 28, y: 22 },
  ...ROOMS.flatMap((room) => {
    const props: Prop[] = [
      { kind: room.type === "twin" ? "twin" : "bed", x: room.beds[0]!.x, y: room.beds[0]!.y, roomId: room.id },
      { kind: "bath", x: room.bath.x, y: room.bath.y, roomId: room.id },
      { kind: "lamp", x: room.lamp.x, y: room.lamp.y, roomId: room.id },
      { kind: "plant", x: room.x + 1, y: 5, roomId: room.id },
    ];
    if (room.beds[1]) props.push({ kind: "twin", x: room.beds[1].x, y: room.beds[1].y, roomId: room.id });
    return props;
  }),
];

export function tileCenter(x: number, y: number): { sx: number; sy: number } {
  return {
    sx: (x - y) * (TILE_W / 2),
    sy: (x + y) * (TILE_H / 2) + TILE_H / 2,
  };
}

export function screenToTile(wx: number, wy: number): { x: number; y: number } {
  const a = wx / (TILE_W / 2);
  const b = (wy - TILE_H / 2) / (TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
