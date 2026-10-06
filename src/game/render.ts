import { bookingHeadline } from "./format.ts";
import { FLOOR, MAP_H, MAP_W, PROPS, ROOMS, TILE_H, TILE_W, WALK, screenToTile, tileCenter } from "./map.ts";
import { getArt } from "./sprites.ts";
import type { Booking, GameState, Room } from "./types.ts";

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type Selection =
  | { kind: "room"; id: string }
  | { kind: "booking"; id: string }
  | { kind: "employee"; id: string }
  | { kind: "vehicle"; id: string };

const STATUS_COLOR: Record<Room["status"], string> = {
  clean: "#2c6b4a",
  occupied: "#8d3b32",
  dirty: "#a67c3d",
  cleaning: "#2f5a4c",
  inspecting: "#3d6f8f",
  ooo: "#6d645c",
  upgrading: "#6d645c",
};

export function project(cam: Camera, x: number, y: number): { x: number; y: number } {
  const p = tileCenter(x, y);
  return { x: p.sx * cam.zoom + cam.x, y: p.sy * cam.zoom + cam.y };
}

function drawImage(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number, ax = 0.5, ay = 1) {
  ctx.drawImage(img, Math.round(x - img.width * ax), Math.round(y - img.height * ay));
}

function drawWall(ctx: CanvasRenderingContext2D, sx: number, sy: number, height: number, windowed: boolean) {
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;
  ctx.beginPath();
  ctx.moveTo(sx - hw, sy);
  ctx.lineTo(sx, sy + hh);
  ctx.lineTo(sx, sy + hh - height);
  ctx.lineTo(sx - hw, sy - height);
  ctx.closePath();
  ctx.fillStyle = "#cbb79a";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sx + hw, sy);
  ctx.lineTo(sx, sy + hh);
  ctx.lineTo(sx, sy + hh - height);
  ctx.lineTo(sx + hw, sy - height);
  ctx.closePath();
  ctx.fillStyle = "#efe6d8";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sx, sy - hh - height);
  ctx.lineTo(sx + hw, sy - height);
  ctx.lineTo(sx, sy + hh - height);
  ctx.lineTo(sx - hw, sy - height);
  ctx.closePath();
  ctx.fillStyle = "#f7f1e6";
  ctx.fill();
  ctx.fillStyle = "#a67c3d";
  ctx.fillRect(sx - hw + 2, sy - height - 2, hw * 2 - 4, 2);
  if (windowed) {
    ctx.fillStyle = "#9ec7c2";
    ctx.fillRect(sx - 5, sy - height + 6, 10, 8);
    ctx.fillStyle = "#fff1c9";
    ctx.fillRect(sx - 3, sy - height + 8, 6, 4);
  }
}

export function render(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameState, cam: Camera, selected: Selection | null) {
  const art = getArt();
  const dpr = ctx.canvas.width / width || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#14342c";
  ctx.fillRect(0, 0, width, height);
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.zoom, cam.zoom);

  type Item = { key: number; z: number; draw: () => void };
  const items: Item[] = [];

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const kind = FLOOR[y * MAP_W + x] ?? "grass";
      const walk = WALK[y * MAP_W + x] ?? 0;
      const p = tileCenter(x, y);
      items.push({
        key: x + y,
        z: 0,
        draw: () => drawImage(ctx, art.floors[kind], p.sx, p.sy, 0.5, 0.5),
      });
      if (walk === 0 && kind === "stone") {
        const room = ROOMS.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
        const cutaway = room ? y === room.y + room.h - 1 : false;
        if (!cutaway) {
          const windowed = !!room && y === room.y && Math.abs(x - room.window.x) <= 1;
          items.push({
            key: x + y,
            z: 1,
            draw: () => drawWall(ctx, p.sx, p.sy, room ? (y === room.y ? 26 : 12) : 14, windowed),
          });
        }
      }
      if (kind === "grass" && walk === 0 && (x * 3 + y * 5) % 19 === 0) {
        items.push({
          key: x + y,
          z: 2,
          draw: () => drawImage(ctx, art.plant, p.sx, p.sy - 2),
        });
      }
    }
  }

  for (const prop of PROPS) {
    const p = tileCenter(prop.x, prop.y);
    const img =
      prop.kind === "bed"
        ? art.bed
        : prop.kind === "twin"
          ? art.twin
          : prop.kind === "bath"
            ? art.bath
            : prop.kind === "desk"
              ? art.desk
              : prop.kind === "sofa"
                ? art.sofa
                : prop.kind === "table"
                  ? art.table
                  : prop.kind === "plant"
                    ? art.plant
                    : prop.kind === "lamp"
                      ? art.lamp
                      : prop.kind === "cart"
                        ? art.cart
                        : prop.kind === "shelf"
                          ? art.shelf
                          : prop.kind === "canopy"
                            ? art.canopy
                            : art.counter;
    items.push({ key: prop.x + prop.y + 0.2, z: 2, draw: () => drawImage(ctx, img, p.sx, p.sy - 2) });
  }

  for (const room of ROOMS) {
    const p = tileCenter(room.door.x, room.door.y);
    const live = state.rooms.find((r) => r.id === room.id);
    items.push({
      key: room.door.x + room.door.y + 0.1,
      z: 3,
      draw: () => {
        ctx.fillStyle = STATUS_COLOR[live?.status ?? "clean"];
        ctx.fillRect(p.sx - 3, p.sy - 14, 6, 6);
        ctx.fillStyle = "#f7f1e6";
        ctx.font = "7px 'WenQuanYi Zen Hei', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(room.id, p.sx, p.sy - 16);
      },
    });
  }

  for (const emp of state.employees) {
    if (emp.hidden) continue;
    const p = tileCenter(emp.x - 0.5, emp.y - 0.5);
    const frame = art.actors[emp.role][(emp.dir % 4) * 4 + (emp.frame % 4)] ?? art.actors[emp.role][0]!;
    items.push({ key: emp.x + emp.y, z: 4, draw: () => drawImage(ctx, frame, p.sx, p.sy) });
  }

  for (const booking of state.bookings) {
    booking.party.forEach((person, index) => {
      if (!person.visible || person.onboard) return;
      const p = tileCenter(person.x - 0.5, person.y - 0.5);
      const frame = art.actors[person.look][(person.dir % 4) * 4 + (person.frame % 4)] ?? art.actors[person.look][0]!;
      items.push({
        key: person.x + person.y + index * 0.01,
        z: 4,
        draw: () => drawImage(ctx, frame, p.sx + index * 5, p.sy),
      });
    });
  }

  state.vehicles.forEach((veh, index) => {
    const p = tileCenter(veh.x - 0.5, veh.y - 0.5);
    const img = art.van[veh.dir % 2] ?? art.van[0]!;
    items.push({ key: veh.x + veh.y, z: 4, draw: () => drawImage(ctx, img, p.sx, p.sy - index) });
  });

  if (selected?.kind === "room") {
    const room = ROOMS.find((r) => r.id === selected.id);
    if (room) {
      for (let y = room.y; y < room.y + room.h; y++) {
        for (let x = room.x; x < room.x + room.w; x++) {
          const p = tileCenter(x, y);
          items.push({
            key: x + y,
            z: 0.4,
            draw: () => {
              ctx.strokeStyle = "#e2b45e";
              ctx.strokeRect(p.sx - 8, p.sy - 4, 16, 8);
            },
          });
        }
      }
    }
  }

  items.sort((a, b) => a.key - b.key || a.z - b.z);
  for (const item of items) item.draw();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.font = "12px 'Noto Sans SC', 'WenQuanYi Zen Hei', sans-serif";
  ctx.textAlign = "center";
  const bubbles: { x: number; y: number; text: string }[] = [];
  for (const task of state.tasks) {
    if (task.status !== "active" && task.status !== "waiting") continue;
    if (!task.statusText) continue;
    const emp = state.employees.find((e) => e.id === task.assigneeId);
    const veh = state.vehicles.find((v) => v.id === task.vehicleId);
    const booking = state.bookings.find((b) => b.id === task.bookingId);
    const spot = emp && !emp.hidden ? emp : veh ? veh : booking?.party.find((p) => p.visible);
    if (!spot) continue;
    const pos = project(cam, spot.x - 0.5, spot.y - 0.5);
    bubbles.push({ x: pos.x, y: pos.y - 28, text: task.statusText.replace(/\s+\d+%$/, "") });
    if (bubbles.length >= 6) break;
  }
  for (const bubble of bubbles) {
    const widthText = Math.min(168, ctx.measureText(bubble.text).width + 14);
    ctx.fillStyle = "rgba(251,247,241,0.94)";
    ctx.fillRect(bubble.x - widthText / 2, bubble.y - 16, widthText, 18);
    ctx.fillStyle = "#1c3a32";
    ctx.fillText(bubble.text, bubble.x, bubble.y - 3);
  }

  ctx.font = "12px 'Noto Sans SC', 'WenQuanYi Zen Hei', sans-serif";
  ctx.textAlign = "center";
  const places: [string, number, number][] = [
    ["套房", 8, 0],
    ["大床房", 26, 0],
    ["双床房", 42, 0],
    ["大堂", 24, 14],
    ["礼宾", 30, 12],
    ["餐厅", 40, 12],
    ["厨房", 41, 20],
    ["洗衣", 6, 12],
    ["落客", 24, 26],
    ["车站", 4, 26],
  ];
  for (const [text, tx, ty] of places) {
    const pos = project(cam, tx, ty);
    if (pos.x < 8 || pos.y < 16 || pos.x > width - 8 || pos.y > height - 8) continue;
    ctx.fillStyle = "rgba(28,58,50,0.55)";
    const w = ctx.measureText(text).width + 10;
    ctx.fillRect(pos.x - w / 2, pos.y - 12, w, 16);
    ctx.fillStyle = "#f4efe7";
    ctx.fillText(text, pos.x, pos.y);
  }
}

export function pickAt(state: GameState, cam: Camera, sx: number, sy: number): Selection | null {
  let bestSel: Selection | null = null;
  let bestD = 22;
  const consider = (sel: Selection, x: number, y: number) => {
    const p = project(cam, x - 0.5, y - 0.5);
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d < bestD) {
      bestD = d;
      bestSel = sel;
    }
  };
  for (const veh of state.vehicles) consider({ kind: "vehicle", id: veh.id }, veh.x, veh.y);
  for (const emp of state.employees) if (!emp.hidden) consider({ kind: "employee", id: emp.id }, emp.x, emp.y);
  for (const booking of state.bookings) {
    for (const person of booking.party) {
      if (person.visible && !person.onboard) consider({ kind: "booking", id: booking.id }, person.x, person.y);
    }
  }
  if (bestSel) return bestSel;
  const world = screenToTile((sx - cam.x) / cam.zoom, (sy - cam.y) / cam.zoom);
  const tx = Math.floor(world.x);
  const ty = Math.floor(world.y);
  const room = ROOMS.find((r) => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h);
  if (room) return { kind: "room", id: room.id };
  return null;
}

export function roomLabel(state: GameState, id: string): string {
  const booking = state.bookings.find((b) => b.roomId === id && !b.departed && !b.checkedOut);
  return booking ? bookingHeadline(state, booking) : "";
}

export type { Booking };
