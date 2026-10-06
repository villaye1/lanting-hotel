import type { Floor } from "./map.ts";
import { TILE_H, TILE_W } from "./map.ts";
import type { Look } from "./types.ts";

const ivory = "#f4ecdf";
const stone = "#d9c7ae";
const stoneDeep = "#b79a78";
const wood = "#6a4330";
const woodDeep = "#3c261b";
const carpet = "#21483c";
const carpetDeep = "#17362d";
const gold = "#e2b45e";
const brass = "#8d6432";
const plant = "#3f6d46";
const plantDeep = "#274833";
const linen = "#f7f2e8";
const road = "#3d4440";
const glass = "#b7d4cf";
const blush = "#8f3d45";

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function diamond(kind: Floor): HTMLCanvasElement {
  const c = canvas(TILE_W, TILE_H);
  const ctx = c.getContext("2d")!;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(32, 8);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8);
  ctx.closePath();
  const top =
    kind === "carpet" ? carpet : kind === "wood" ? "#8a6244" : kind === "tile" ? "#efe6d6" : kind === "road" ? road : kind === "court" ? "#efe4d2" : kind === "grass" ? "#6e8f62" : stone;
  const left =
    kind === "carpet" ? carpetDeep : kind === "wood" ? wood : kind === "tile" ? "#e4d8c4" : kind === "road" ? "#2e3431" : kind === "court" ? "#e5d3b8" : kind === "grass" ? "#5d7a52" : stoneDeep;
  ctx.fillStyle = top;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(16, 8);
  ctx.lineTo(32, 8);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8);
  ctx.closePath();
  ctx.fillStyle = left;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(32, 8);
  ctx.lineTo(16, 16);
  ctx.lineTo(0, 8);
  ctx.closePath();
  ctx.strokeStyle = "rgba(42,34,28,0.18)";
  ctx.lineWidth = 1;
  ctx.stroke();
  if (kind === "road") {
    px(ctx, 14, 7, 4, 2, "#d7c7a2");
  }
  if (kind === "carpet") px(ctx, 15, 6, 2, 2, "#c4a15a");
  return c;
}

function prop(draw: (ctx: CanvasRenderingContext2D) => void, w = 32, h = 32): HTMLCanvasElement {
  const c = canvas(w, h);
  const ctx = c.getContext("2d")!;
  draw(ctx);
  return c;
}

function bed(twin: boolean): HTMLCanvasElement {
  return prop((ctx) => {
    px(ctx, 4, 16, 24, 8, woodDeep);
    px(ctx, 5, 10, 22, 8, twin ? "#d9c7a4" : "#1f4a3c");
    px(ctx, 6, 8, 20, 6, linen);
    px(ctx, 7, 7, 7, 4, ivory);
    px(ctx, 16, 7, 7, 4, twin ? ivory : "#f3e6ea");
    px(ctx, 4, 6, 22, 4, wood);
    px(ctx, 20, 4, 3, 6, gold);
  }, 32, 28);
}

function actorSheet(look: Look): HTMLCanvasElement[] {
  const uniform =
    look === "vip"
      ? "#241c22"
      : look === "business"
        ? "#2c3844"
        : look === "family"
          ? "#6d4a3a"
          : look === "child"
            ? "#c4a15a"
            : look === "front"
              ? "#f3ecdf"
              : look === "bell"
                ? "#1d3b32"
                : look === "house"
                  ? "#f7f1e7"
                  : look === "chef"
                    ? "#f4f0ea"
                    : "#243038";
  const trim = look === "front" || look === "house" ? brass : gold;
  const frames: HTMLCanvasElement[] = [];
  for (let dir = 0; dir < 4; dir++) {
    for (let frame = 0; frame < 4; frame++) {
      const c = canvas(20, 28);
      const ctx = c.getContext("2d")!;
      const step = [0, 1, 0, -1][frame] ?? 0;
      const bob = frame % 2 === 0 ? 0 : 1;
      px(ctx, 6, 24, 8, 2, "rgba(30,24,18,0.35)");
      const skin = "#e7b592";
      px(ctx, 7 + step, 16 + bob, 2, 6, woodDeep);
      px(ctx, 11 - step, 16 + bob, 2, 6, "#2a211c");
      px(ctx, 6, 10 + bob, 8, 8, uniform);
      px(ctx, 6, 10 + bob, 8, 2, trim);
      if (look === "chef") px(ctx, 6, 4 + bob, 8, 3, ivory);
      if (look === "driver") px(ctx, 6, 5 + bob, 8, 2, "#1c2428");
      if (look === "bell") px(ctx, 9, 12 + bob, 2, 3, gold);
      px(ctx, 7, 5 + bob, 6, 5, skin);
      px(ctx, 7, 4 + bob, 6, 2, look === "vip" ? "#1a1412" : look === "child" ? "#8a5a32" : "#2a211c");
      if (dir === 0 || dir === 2) px(ctx, dir === 0 ? 12 : 5, 11 + bob, 2, 5, skin);
      if (look === "child") {
        px(ctx, 8, 8 + bob, 4, 3, blush);
      }
      frames.push(c);
    }
  }
  return frames;
}

export interface Art {
  floors: Record<Floor, HTMLCanvasElement>;
  bed: HTMLCanvasElement;
  twin: HTMLCanvasElement;
  bath: HTMLCanvasElement;
  desk: HTMLCanvasElement;
  sofa: HTMLCanvasElement;
  table: HTMLCanvasElement;
  plant: HTMLCanvasElement;
  lamp: HTMLCanvasElement;
  cart: HTMLCanvasElement;
  shelf: HTMLCanvasElement;
  counter: HTMLCanvasElement;
  canopy: HTMLCanvasElement;
  actors: Record<Look, HTMLCanvasElement[]>;
  van: HTMLCanvasElement[];
}

let art: Art | null = null;

export function getArt(): Art {
  if (art) return art;
  art = {
    floors: {
      grass: diamond("grass"),
      stone: diamond("stone"),
      carpet: diamond("carpet"),
      wood: diamond("wood"),
      tile: diamond("tile"),
      road: diamond("road"),
      court: diamond("court"),
    },
    bed: bed(false),
    twin: bed(true),
    bath: prop((ctx) => {
      px(ctx, 8, 12, 14, 10, "#d5e4e1");
      px(ctx, 10, 8, 10, 6, glass);
      px(ctx, 13, 14, 4, 3, brass);
    }),
    desk: prop((ctx) => {
      px(ctx, 2, 16, 28, 8, woodDeep);
      px(ctx, 4, 12, 24, 6, wood);
      px(ctx, 22, 10, 4, 4, gold);
    }, 32, 28),
    sofa: prop((ctx) => {
      px(ctx, 4, 14, 24, 8, carpet);
      px(ctx, 6, 12, 20, 4, "#2f6152");
      px(ctx, 6, 16, 4, 4, gold);
      px(ctx, 22, 16, 4, 4, gold);
    }, 32, 26),
    table: prop((ctx) => {
      px(ctx, 6, 14, 18, 8, wood);
      px(ctx, 8, 10, 14, 5, linen);
      px(ctx, 13, 8, 4, 3, plant);
    }, 30, 26),
    plant: prop((ctx) => {
      px(ctx, 12, 16, 6, 6, brass);
      px(ctx, 8, 8, 14, 9, plant);
      px(ctx, 11, 5, 8, 5, plantDeep);
      px(ctx, 14, 7, 3, 3, "#d7c4cf");
    }, 28, 26),
    lamp: prop((ctx) => {
      px(ctx, 13, 14, 4, 8, brass);
      px(ctx, 10, 8, 10, 6, gold);
      px(ctx, 12, 6, 6, 3, "#fff1c9");
    }, 28, 26),
    cart: prop((ctx) => {
      px(ctx, 6, 16, 18, 6, brass);
      px(ctx, 8, 10, 12, 7, woodDeep);
      px(ctx, 8, 18, 3, 3, "#222");
      px(ctx, 18, 18, 3, 3, "#222");
    }, 30, 26),
    shelf: prop((ctx) => {
      px(ctx, 6, 8, 18, 14, wood);
      px(ctx, 8, 12, 14, 2, gold);
      px(ctx, 8, 16, 14, 2, linen);
    }, 30, 26),
    counter: prop((ctx) => {
      px(ctx, 2, 12, 28, 10, woodDeep);
      px(ctx, 4, 8, 24, 6, stone);
      px(ctx, 20, 6, 6, 3, glass);
    }, 32, 26),
    canopy: prop((ctx) => {
      px(ctx, 8, 6, 4, 16, brass);
      px(ctx, 6, 4, 8, 3, gold);
    }, 20, 26),
    actors: {
      business: actorSheet("business"),
      family: actorSheet("family"),
      vip: actorSheet("vip"),
      child: actorSheet("child"),
      front: actorSheet("front"),
      bell: actorSheet("bell"),
      house: actorSheet("house"),
      driver: actorSheet("driver"),
      chef: actorSheet("chef"),
    },
    van: [0, 1].map((flip) =>
      prop((ctx) => {
        const x = flip ? 8 : 4;
        px(ctx, x, 16, 36, 8, "#2a241c");
        px(ctx, x + 2, 8, 32, 10, ivory);
        px(ctx, x + 4, 10, 10, 5, glass);
        px(ctx, x + 16, 10, 10, 5, glass);
        px(ctx, x + 2, 14, 32, 2, gold);
        px(ctx, x + 4, 20, 5, 4, "#1b1b1b");
        px(ctx, x + 24, 20, 5, 4, "#1b1b1b");
        px(ctx, x + 28, 9, 4, 3, brass);
      }, 52, 30),
    ),
  };
  return art;
}
