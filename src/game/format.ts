import { KIND_LABEL, PKG_LABEL, ROLE_LABEL, ROOM_LABEL, type Role, type RoomType } from "./config.ts";
import type { Booking, GameState, Journey, RoomStatus, Task } from "./types.ts";

export function absOf(day: number, minute: number): number {
  return (day - 1) * 1440 + minute;
}

export function dayOf(abs: number): number {
  return Math.floor(abs / 1440) + 1;
}

export function minuteOf(abs: number): number {
  return ((abs % 1440) + 1440) % 1440;
}

export function nowAbs(s: GameState): number {
  return absOf(s.time.day, s.time.minute);
}

export function dateKey(day: number): string {
  return `D${day}`;
}

export function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function clock(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function dateLabel(day: number, minute: number): string {
  return `第${day}日 ${clock(minute)}`;
}

export function money(n: number): string {
  const v = Math.round(n);
  const sign = v < 0 ? "-" : "";
  return `${sign}¥${Math.abs(v).toLocaleString("zh-CN")}`;
}

export function roomStatusLabel(status: RoomStatus): string {
  switch (status) {
    case "clean":
      return "干净可售";
    case "occupied":
      return "在住";
    case "dirty":
      return "退房待清洁";
    case "cleaning":
      return "清洁中";
    case "inspecting":
      return "房间检查中";
    case "ooo":
      return "停用";
    case "upgrading":
      return "升级中";
  }
}

export function journeyLabel(j: Journey): string {
  switch (j) {
    case "booked":
      return "已预订";
    case "pickup":
      return "正在接驳";
    case "at_hotel":
      return "已到店";
    case "in_house":
      return "在住";
    case "departing":
      return "正在离店";
    case "done":
      return "行程结束";
  }
}

export function kindLabel(kind: Booking["kind"]): string {
  return KIND_LABEL[kind];
}

export function pkgLabel(pkg: Booking["pkg"]): string {
  return PKG_LABEL[pkg];
}

export function roomTypeLabel(t: RoomType): string {
  return ROOM_LABEL[t];
}

export function roleLabel(r: Role): string {
  return ROLE_LABEL[r];
}

const OPEN = new Set(["pending", "waiting", "active"]);

export function openTasks(s: GameState, bookingId: string): Task[] {
  return s.tasks.filter((t) => OPEN.has(t.status) && (t.bookingId === bookingId || t.bookingIds.includes(bookingId)));
}

export function bookingHeadline(s: GameState, b: Booking): string {
  const tasks = openTasks(s, b.id);
  const active = tasks.find((t) => t.status === "active");
  if (active?.statusText) return active.statusText;
  const waiting = tasks.find((t) => t.waitReason);
  if (waiting?.waitReason) return waiting.waitReason;
  if (b.journey === "done") return "已送到离店地点";
  if (b.bagWhere === "room" && b.checkedIn) return "行李已送达";
  return journeyLabel(b.journey);
}

export function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function avgScores(b: Booking): number {
  const sc = b.satisfaction;
  return (sc.transfer + sc.arrival + sc.room + sc.dining + sc.departure) / 5;
}
