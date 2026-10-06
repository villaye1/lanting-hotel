import { CONFIG, ROLE_LABEL, type Role } from "./config.ts";
import {
  canAssignRoom,
  createGame,
  makeEmployee,
  makeVehicle,
  rngName,
  roll,
  shiftLate,
  tryBook,
} from "./factory.ts";
import { absOf, avgScores, clampScore, clock, dateKey, dayOf, minuteOf, nowAbs } from "./format.ts";
import { SPOT, roomById } from "./map.ts";
import { findPath, nearestWalkable, type Who } from "./path.ts";
import type {
  Actor,
  Booking,
  Employee,
  GameState,
  Person,
  Pt,
  Room,
  Task,
  TaskType,
  Vehicle,
} from "./types.ts";

export { canAssignRoom, createGame, tryBook };
export { consumeTime };

const OPEN = new Set(["pending", "waiting", "active"]);

type Op = "gate" | "veh" | "staff" | "work" | "wait_arrival" | "wait_ready";
interface Phase {
  op: Op;
  dest?: string;
  min?: number;
  text: string;
  key: string;
}

function consumeTime(acc: number, dt: number, speed: number): { acc: number; minutes: number } {
  if (!(speed > 0) || !(dt > 0)) return { acc, minutes: 0 };
  const step = CONFIG.dayRealSeconds / 1440;
  let a = acc + dt * speed;
  let minutes = 0;
  while (a >= step - 1e-9 && minutes < 30000) {
    a -= step;
    minutes += 1;
  }
  return { acc: a, minutes };
}

function byId(s: GameState, id: string | null): Booking | undefined {
  if (!id) return undefined;
  return s.bookings.find((b) => b.id === id);
}

function roomOf(s: GameState, id: string): Room | undefined {
  return s.rooms.find((r) => r.id === id);
}

function empOf(s: GameState, id: string | null): Employee | undefined {
  if (!id) return undefined;
  return s.employees.find((e) => e.id === id);
}

function vehOf(s: GameState, id: string | null): Vehicle | undefined {
  if (!id) return undefined;
  return s.vehicles.find((v) => v.id === id);
}

function personOf(s: GameState, id: string): Person | undefined {
  for (const b of s.bookings) {
    const p = b.party.find((x) => x.id === id);
    if (p) return p;
  }
  return undefined;
}

export function log(s: GameState, text: string) {
  s.log.unshift({ abs: nowAbs(s), text });
  if (s.log.length > 80) s.log.length = 80;
}

export function toast(s: GameState, text: string) {
  s.ids.toast += 1;
  s.toasts.unshift({ id: `Z${s.ids.toast}`, text });
  if (s.toasts.length > 4) s.toasts.length = 4;
}

function addLedger(
  s: GameState,
  e: {
    kind: string;
    note: string;
    cashDelta: number;
    revenueDelta: number;
    receivableDelta: number;
    opexDelta: number;
    capexDelta: number;
    bookingId: string | null;
    dedupeKey: string;
  },
): boolean {
  if (s.ledger.some((row) => row.dedupeKey === e.dedupeKey)) return false;
  s.ids.ledger += 1;
  s.cash += e.cashDelta;
  s.ledger.push({
    id: `L${s.ids.ledger}`,
    hotelId: "h1",
    abs: nowAbs(s),
    day: s.time.day,
    ...e,
  });
  return true;
}

function postCharge(s: GameState, b: Booking, dedupe: string, label: string, amount: number) {
  if (b.folio.some((l) => l.dedupe === dedupe)) return;
  b.folio.push({ id: dedupe, label, amount, cost: 0, dedupe });
  addLedger(s, {
    kind: amount > 0 ? "revenue" : "note",
    note: label,
    cashDelta: 0,
    revenueDelta: amount,
    receivableDelta: amount,
    opexDelta: 0,
    capexDelta: 0,
    bookingId: b.id,
    dedupeKey: dedupe,
  });
}

function postCost(s: GameState, dedupe: string, note: string, cost: number, bookingId: string | null) {
  if (cost <= 0) return;
  addLedger(s, {
    kind: "cogs",
    note,
    cashDelta: -cost,
    revenueDelta: 0,
    receivableDelta: 0,
    opexDelta: cost,
    capexDelta: 0,
    bookingId,
    dedupeKey: dedupe,
  });
}

function postCapex(s: GameState, dedupe: string, note: string, cost: number): boolean {
  if (s.cash < cost) {
    toast(s, `现金不足，还差 ¥${Math.ceil(cost - s.cash)}`);
    return false;
  }
  return addLedger(s, {
    kind: "capex",
    note,
    cashDelta: -cost,
    revenueDelta: 0,
    receivableDelta: 0,
    opexDelta: 0,
    capexDelta: cost,
    bookingId: null,
    dedupeKey: dedupe,
  });
}

function settle(s: GameState, b: Booking) {
  if (b.settled) return;
  const due = b.folio.reduce((sum, line) => sum + line.amount, 0);
  b.settled = true;
  addLedger(s, {
    kind: "settlement",
    note: `退房收款 ${b.party[0]?.name ?? b.id}`,
    cashDelta: due,
    revenueDelta: 0,
    receivableDelta: -due,
    opexDelta: 0,
    capexDelta: 0,
    bookingId: b.id,
    dedupeKey: `settle:${b.id}`,
  });
  log(s, `${b.party[0]?.name ?? "客人"} 已结账 ${due} 元`);
}

function postDueNights(s: GameState, b: Booking) {
  if (!b.checkedIn) return;
  const start = dayOf(b.arrivalAbs);
  for (let i = 0; i < b.nights; i++) {
    const nightDay = start + i;
    const auditAt = absOf(nightDay + 1, 180);
    const due = nowAbs(s) >= auditAt || (b.checkedOut && nowAbs(s) >= absOf(nightDay + 1, 0));
    if (!due) continue;
    const key = `room:${b.id}:${dateKey(nightDay)}`;
    if (!s.postedNights.includes(key)) s.postedNights.push(key);
    postCharge(s, b, key, `房费 ${b.roomId} · 第${nightDay}日`, b.nightly);
  }
}

function taskExists(s: GameState, key: string): boolean {
  return s.tasks.some((t) => t.dedupeKey === key && t.status !== "cancelled" && t.status !== "exception");
}

function roleFor(type: TaskType): Role {
  switch (type) {
    case "pickup":
    case "dropoff":
    case "return":
      return "driver";
    case "check_in":
    case "checkout":
    case "complaint":
      return "front";
    case "cook":
      return "chef";
    case "clean":
    case "inspect":
    case "laundry":
      return "house";
    default:
      return "bell";
  }
}

function canDo(s: GameState, emp: Employee, role: Role): boolean {
  if (emp.skills.includes(role) || emp.role === role) return true;
  if (!s.training) return false;
  if (emp.role === "bell" && (role === "house" || role === "front")) return true;
  if (emp.role === "house" && role === "bell") return true;
  if (emp.role === "front" && role === "bell") return true;
  return false;
}

function phaseList(t: Task): Phase[] {
  switch (t.type) {
    case "pickup":
      return [
        { op: "veh", dest: "station", text: "前往机场接客", key: "go" },
        { op: "wait_arrival", text: "客人候车", key: "wait-guest" },
        { op: "work", min: CONFIG.loadMinutes, text: "核对人数与行李", key: "board" },
        { op: "veh", dest: "porte", text: "送客人回酒店", key: "go" },
        { op: "work", min: CONFIG.loadMinutes, text: "到店卸客", key: "unboard" },
      ];
    case "dropoff":
      return [
        { op: "veh", dest: "porte", text: "接驳车前往门厅", key: "go" },
        { op: "wait_ready", text: "等待客人与行李", key: "wait-out" },
        { op: "work", min: CONFIG.loadMinutes, text: "核对行李并上车", key: "board-out" },
        { op: "veh", dest: "station", text: "送客前往车站", key: "go" },
        { op: "work", min: CONFIG.loadMinutes, text: "确认交接", key: "handed" },
      ];
    case "return":
      return [{ op: "veh", dest: "depot", text: "车辆返程", key: "go" }];
    case "greet":
      return [
        { op: "staff", dest: "porteGuest", text: "礼宾前往门厅", key: "go" },
        { op: "work", min: CONFIG.greetMinutes, text: "迎接客人", key: "greeted" },
      ];
    case "check_in":
      return [
        { op: "gate", text: "等待可入住", key: "gate-in" },
        { op: "staff", dest: "desk", text: "前台办理入住", key: "go" },
        { op: "work", min: CONFIG.checkMinutes, text: "办理入住", key: "checked-in" },
      ];
    case "checkout":
      return [
        { op: "gate", text: "等待离店时间", key: "gate-out" },
        { op: "staff", dest: "desk", text: "前台办理退房", key: "go" },
        { op: "work", min: CONFIG.checkMinutes, text: "退房结算", key: "checked-out" },
      ];
    case "deliver_bag":
      return [
        { op: "gate", text: "等待行李可入房", key: "gate-bag" },
        { op: "staff", dest: "porteGuest", text: "礼宾接收行李", key: "go" },
        { op: "staff", dest: "room", text: "行李送往客房", key: "go" },
        { op: "work", min: 2, text: "放置行李", key: "bag-in" },
      ];
    case "collect_bag":
      return [
        { op: "staff", dest: "room", text: "前往客房取行李", key: "go" },
        { op: "staff", dest: "porteGuest", text: "行李送往门厅", key: "go" },
        { op: "work", min: 2, text: "行李交接到门厅", key: "bag-porte" },
      ];
    case "cook":
      return [
        { op: "staff", dest: "kitchen", text: "厨师备料", key: "go" },
        { op: "work", min: CONFIG.cookMinutes, text: t.tag === "dinner" ? "制作客房餐" : "制作早餐", key: "cooked" },
      ];
    case "serve":
      return [
        { op: "gate", text: "等待可入房", key: "gate-serve" },
        { op: "staff", dest: t.tag === "restaurant" ? "restaurant" : "room", text: t.tag === "restaurant" ? "送往餐厅" : "送餐到客房", key: "go" },
        { op: "work", min: 2, text: t.tag === "dinner" ? "客房送餐" : "送上早餐", key: "served" },
      ];
    case "collect_dish":
      return [
        { op: "staff", dest: t.tag === "room" ? "room" : "restaurant", text: "前往回收餐具", key: "go" },
        { op: "work", min: CONFIG.dishMinutes, text: "回收餐具", key: "dished" },
      ];
    case "amenity":
      return [
        { op: "gate", text: "等待可入房", key: "gate-serve" },
        { op: "staff", dest: "room", text: "送上迎宾礼", key: "go" },
        { op: "work", min: CONFIG.amenityMinutes, text: "布置迎宾礼", key: "welcomed" },
      ];
    case "clean":
      return [
        { op: "staff", dest: "room", text: "客房员前往清洁", key: "go" },
        { op: "work", min: cleanMinutes(t), text: "清洁客房", key: "cleaned" },
      ];
    case "inspect":
      return [
        { op: "staff", dest: "room", text: "前往检查客房", key: "go" },
        { op: "work", min: CONFIG.inspectMinutes, text: "检查客房", key: "inspected" },
      ];
    case "laundry":
      return [
        { op: "gate", text: "等待可入房", key: "gate-serve" },
        { op: "staff", dest: "room", text: "收取洗衣", key: "go" },
        { op: "staff", dest: "laundry", text: "送往洗衣房", key: "go" },
        { op: "work", min: CONFIG.laundryMinutes, text: "洗涤衣物", key: "laundered" },
      ];
    case "complaint":
      return [
        { op: "staff", dest: "desk", text: "前台处理投诉", key: "go" },
        { op: "work", min: CONFIG.complaintMinutes, text: "处理投诉", key: "apologized" },
      ];
  }
}

function cleanMinutes(t: Task): number {
  const room = t.roomId ? roomById(t.roomId) : null;
  if (!room) return CONFIG.cleanMinutes.king;
  return CONFIG.cleanMinutes[room.type];
}

function workNeed(s: GameState, base: number): number {
  return Math.max(1, Math.round(base * (s.training ? CONFIG.trainingFactor : 1)));
}

function createTask(
  s: GameState,
  partial: {
    type: TaskType;
    bookingIds?: string[];
    dedupeKey: string;
    notBefore?: number;
    deadlineAbs?: number;
    roomId?: string | null;
    tag?: string;
    prereq?: string[];
  },
): Task {
  s.ids.task += 1;
  const task: Task = {
    id: `T${s.ids.task}`,
    hotelId: "h1",
    bookingId: partial.bookingIds?.[0] ?? null,
    bookingIds: partial.bookingIds ?? [],
    type: partial.type,
    prereq: partial.prereq ?? [],
    status: "pending",
    assigneeId: null,
    vehicleId: null,
    phase: 0,
    phaseMin: 0,
    createdAbs: nowAbs(s),
    deadlineAbs: partial.deadlineAbs ?? nowAbs(s) + 120,
    notBefore: partial.notBefore ?? 0,
    waitReason: "",
    statusText: "等待安排",
    priorityBoost: 0,
    released: s.policies.autoAssign,
    dedupeKey: partial.dedupeKey,
    roomId: partial.roomId ?? null,
    tag: partial.tag ?? "",
    idleMin: 0,
  };
  s.tasks.push(task);
  return task;
}

function bookingsOf(s: GameState, t: Task): Booking[] {
  return t.bookingIds.map((id) => byId(s, id)).filter((b): b is Booking => !!b);
}

function holdReason(s: GameState, t: Task): string | null {
  const now = nowAbs(s);
  if (now < t.notBefore) return t.type === "pickup" || t.type === "dropoff" ? "未到发车时间" : "未到出发时间";
  if (t.prereq.some((id) => s.tasks.find((x) => x.id === id)?.status !== "done")) return "等待前置步骤";
  const ph = phaseList(t)[t.phase];
  if (!ph || ph.op !== "gate") return null;
  const b = byId(s, t.bookingId);
  if (!b && t.type !== "clean" && t.type !== "inspect") return null;
  if (ph.key === "gate-in" && b) return checkinGate(s, b);
  if (ph.key === "gate-out" && b) return now < b.checkoutAbs ? "未到退房时间" : null;
  if (ph.key === "gate-bag" && b) return bagGate(s, b);
  if (ph.key === "gate-serve" && b) return serveGate(s, b);
  return null;
}

function checkinGate(s: GameState, b: Booking): string | null {
  if (!b.arrivedHotel) return "等待客人到店";
  const room = roomOf(s, b.roomId);
  if (!room) return "找不到房间";
  const early =
    !s.policies.earlyCheckIn &&
    minuteOf(b.arrivalAbs) < CONFIG.standardCheckIn &&
    nowAbs(s) < absOf(dayOf(b.arrivalAbs), CONFIG.standardCheckIn);
  if (early) return "未到入住时间";
  const check = canAssignRoom(room, {
    party: b.partySize,
    type: b.roomType,
    dates: [],
    mode: "checkin",
    ignoreBookingId: b.id,
  });
  return check.ok ? null : check.reason;
}

function bagGate(s: GameState, b: Booking): string | null {
  if (!b.arrivedHotel) return "等待客人到店";
  if (b.bagWhere !== "porte" && b.bagWhere !== "bell") return "等待行李到店";
  const room = roomOf(s, b.roomId);
  if (!room) return "找不到房间";
  if (room.status === "dirty" || room.status === "cleaning") return "房间清洁中";
  if (room.status === "inspecting") return "房间检查中";
  if (room.status === "ooo" || room.status === "upgrading") return "房间停用";
  if (b.checkedIn && b.dnd && !b.entryOverride) return "请勿打扰";
  return null;
}

function serveGate(s: GameState, b: Booking): string | null {
  if (!b.checkedIn || b.checkedOut) return "客人尚未入住";
  if (b.dnd && !b.entryOverride) return "请勿打扰";
  return null;
}

function needsNow(t: Task): { role: Role | null; vehicle: boolean } {
  const ph = phaseList(t)[t.phase];
  if (!ph || ph.op === "gate") return { role: null, vehicle: false };
  if (t.type === "pickup" || t.type === "dropoff" || t.type === "return") return { role: "driver", vehicle: true };
  return { role: roleFor(t.type), vehicle: false };
}

function priority(s: GameState, t: Task): number {
  const base: Record<TaskType, number> = {
    checkout: 80,
    check_in: 76,
    dropoff: 74,
    pickup: 72,
    collect_bag: 68,
    deliver_bag: 66,
    greet: 64,
    serve: 52,
    cook: 50,
    complaint: 46,
    amenity: 40,
    clean: 36,
    inspect: 34,
    laundry: 28,
    collect_dish: 26,
    return: 6,
  };
  const now = nowAbs(s);
  const age = Math.min(30, (now - t.createdAbs) / 6);
  const late = Math.max(0, Math.min(36, now - t.deadlineAbs));
  return (base[t.type] ?? 10) + age + late + t.priorityBoost;
}

function release(s: GameState, t: Task) {
  const emp = empOf(s, t.assigneeId);
  if (emp && emp.taskId === t.id) {
    emp.taskId = null;
    emp.hidden = false;
    const spot = nearestWalkable(emp.x, emp.y, "staff");
    if (Math.round(emp.x) !== spot.x || Math.round(emp.y) !== spot.y) {
      emp.x = spot.x + 0.5;
      emp.y = spot.y + 0.5;
      emp.path = [];
      emp.goalKey = "";
    }
  }
  const veh = vehOf(s, t.vehicleId);
  if (veh && veh.taskId === t.id) {
    veh.taskId = null;
    veh.exclusive = false;
  }
  t.assigneeId = null;
  t.vehicleId = null;
}

function failTask(s: GameState, t: Task, reason: string) {
  if (t.status === "done" || t.status === "cancelled" || t.status === "exception") return;
  release(s, t);
  t.status = "exception";
  t.waitReason = reason;
  t.statusText = reason;
  for (const id of t.bookingIds) {
    const b = byId(s, id);
    if (!b) continue;
    if (b.pickupTaskId === t.id) b.pickupTaskId = null;
    if (b.dropoffTaskId === t.id) b.dropoffTaskId = null;
  }
  log(s, reason);
}

function completeTask(s: GameState, t: Task) {
  if (t.status === "done") return;
  release(s, t);
  t.status = "done";
  t.waitReason = "";
}

function preemptReturn(s: GameState): Vehicle | null {
  for (const veh of s.vehicles) {
    if (!veh.taskId) continue;
    const task = s.tasks.find((t) => t.id === veh.taskId);
    if (task && task.type === "return" && OPEN.has(task.status)) {
      release(s, task);
      task.status = "cancelled";
      task.statusText = "改为执行接送";
      task.waitReason = "改为执行接送";
      return veh;
    }
  }
  return null;
}

function assign(s: GameState) {
  const queue = s.tasks.filter((t) => t.status === "pending" || t.status === "waiting" || (t.status === "active" && !t.assigneeId));
  queue.sort((a, b) => priority(s, b) - priority(s, a));
  for (const task of queue) {
    if (task.status === "done" || task.status === "cancelled" || task.status === "exception") continue;
    const gate = holdReason(s, task);
    if (gate) {
      if (task.assigneeId || task.vehicleId) release(s, task);
      task.status = "waiting";
      task.waitReason = gate;
      task.statusText = gate;
      continue;
    }
    const need = needsNow(task);
    if (!s.policies.autoAssign && !task.released && !task.assigneeId) {
      task.status = "waiting";
      task.waitReason = "等待手动安排";
      task.statusText = "等待手动安排";
      continue;
    }
    if (!need.role && !need.vehicle) {
      task.status = "active";
      task.waitReason = "";
      continue;
    }
    let veh = task.type === "return" && task.tag ? (s.vehicles.find((v) => v.id === task.tag && (!v.taskId || v.taskId === task.id)) ?? null) : vehOf(s, task.vehicleId);
    if (need.vehicle && veh && veh.taskId !== task.id) {
      veh.taskId = task.id;
      veh.exclusive = false;
      task.vehicleId = veh.id;
    }
    if (need.vehicle && !veh) {
      veh = s.vehicles.find((v) => !v.taskId) ?? null;
      if (!veh) veh = preemptReturn(s);
      if (!veh) {
        task.status = "waiting";
        task.waitReason = "等待车辆";
        task.statusText = "等待车辆";
        continue;
      }
      const group = bookingsOf(s, task);
      if (task.type === "pickup" || task.type === "dropoff") {
        const pax = group.reduce((sum, b) => sum + b.partySize, 0);
        const bags = group.reduce((sum, b) => sum + b.bags, 0);
        if (pax > veh.seats || bags > veh.luggageCap) {
          failTask(s, task, "超过车辆容量");
          continue;
        }
      }
      veh.taskId = task.id;
      veh.exclusive = group.some((b) => b.transfer === "private");
      task.vehicleId = veh.id;
    }
    let emp = empOf(s, task.assigneeId);
    if (need.role && !emp) {
      const free = s.employees.find((e) => !e.taskId && canDo(s, e, need.role as Role));
      if (!free) {
        if (veh && !task.assigneeId) {
          veh.taskId = null;
          veh.exclusive = false;
          task.vehicleId = null;
        }
        task.status = "waiting";
        task.waitReason = `等待${ROLE_LABEL[need.role]}`;
        task.statusText = task.waitReason;
        continue;
      }
      emp = free;
      emp.taskId = task.id;
      task.assigneeId = emp.id;
    }
    task.status = "active";
    task.waitReason = "";
  }
}

function face(actor: Actor, dx: number, dy: number) {
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
  if (Math.abs(dx) > Math.abs(dy)) actor.dir = dx > 0 ? 0 : 1;
  else actor.dir = dy > 0 ? 2 : 3;
}

function moveActor(actor: Actor, speed: number) {
  let left = speed;
  let moved = 0;
  while (left > 0 && actor.path.length) {
    const next = actor.path[0]!;
    const tx = next.x + 0.5;
    const ty = next.y + 0.5;
    const dx = tx - actor.x;
    const dy = ty - actor.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) {
      actor.path.shift();
      continue;
    }
    if (dist <= left) {
      actor.x = tx;
      actor.y = ty;
      actor.path.shift();
      left -= dist;
      moved += dist;
      face(actor, dx, dy);
    } else {
      actor.x += (dx / dist) * left;
      actor.y += (dy / dist) * left;
      moved += left;
      face(actor, dx, dy);
      left = 0;
    }
  }
  if (moved > 0.01) {
    actor.walk += moved * 3.2;
    actor.frame = Math.floor(actor.walk) % 4;
  }
}

function setGoal(actor: Actor, dest: Pt, who: Who) {
  const key = `${who}:${dest.x}:${dest.y}`;
  if (actor.goalKey === key) return;
  actor.goalKey = key;
  actor.path = findPath(Math.floor(actor.x), Math.floor(actor.y), dest.x, dest.y, who);
}

function at(actor: Actor, dest: Pt): boolean {
  return actor.path.length === 0 && Math.hypot(actor.x - (dest.x + 0.5), actor.y - (dest.y + 0.5)) < 0.42;
}

function destOf(s: GameState, t: Task, name: string): Pt {
  const b = byId(s, t.bookingId);
  if (name === "station") return SPOT.stationVeh;
  if (name === "porte") return SPOT.porteVeh;
  if (name === "depot") return SPOT.depotVeh;
  if (name === "desk") return SPOT.deskStaff;
  if (name === "porteGuest") return SPOT.porteGuest;
  if (name === "kitchen") return SPOT.kitchen;
  if (name === "restaurant") return SPOT.restaurant;
  if (name === "laundry") return SPOT.laundry;
  if (name === "room") {
    const id = t.roomId ?? b?.roomId;
    if (id) return roomById(id).inside;
  }
  return SPOT.lobby;
}

function keepPromise(b: Booking, kind: Booking["promises"][number]["kind"], day: number | null, note: string) {
  const p = b.promises.find((item) => item.kind === kind && item.status === "pending" && (day === null || item.day === day));
  if (!p) return;
  p.status = "kept";
  p.note = note;
}

function failPromise(s: GameState, b: Booking, kind: Booking["promises"][number]["kind"], day: number | null, note: string) {
  const p = b.promises.find((item) => item.kind === kind && item.status === "pending" && (day === null || item.day === day));
  if (!p) return;
  p.status = "failed";
  p.note = note;
  b.trust = clampScore(b.trust - 8);
  b.notes.push(note);
  if (kind === "breakfast") b.satisfaction.dining = clampScore(b.satisfaction.dining - 18);
  if (kind === "welcome" || kind === "concierge") b.satisfaction.room = clampScore(b.satisfaction.room - 8);
  if (kind === "transfer" || kind === "private_transfer") b.satisfaction.transfer = clampScore(b.satisfaction.transfer - 16);
  log(s, `${b.party[0]?.name ?? "客人"}：${note}`);
  b.complaintOpen = b.complaintOpen || false;
}

function transferIncluded(b: Booking): boolean {
  if (b.transfer === "self") return true;
  if (b.pkg === "suite") return true;
  return b.pkg === "breakfast" && b.transfer === "shared";
}

function transferPrice(b: Booking): number {
  if (transferIncluded(b) || b.transfer === "self") return 0;
  return b.transfer === "private" ? CONFIG.privateTransferFee : CONFIG.sharedTransferFee;
}

function applyKey(s: GameState, t: Task) {
  const ph = phaseList(t)[t.phase];
  if (!ph) return;
  const group = bookingsOf(s, t);
  const b = group[0];
  const veh = vehOf(s, t.vehicleId);
  if (ph.key === "board" && veh) {
    const pax = group.flatMap((item) => item.party);
    if (pax.length > veh.seats || group.reduce((sum, item) => sum + item.bags, 0) > veh.luggageCap) {
      failTask(s, t, "超过车辆容量");
      return;
    }
    veh.passengers = pax.map((p) => p.id);
    veh.luggage = group.map((item) => ({ bookingId: item.id, count: item.bags }));
    for (const item of group) {
      for (const p of item.party) p.onboard = true;
      item.bagWhere = "vehicle";
      item.journey = "pickup";
    }
    t.statusText = "客人已上车";
  }
  if (ph.key === "unboard") {
    if (veh) {
      veh.passengers = veh.passengers.filter((id) => !group.some((item) => item.party.some((p) => p.id === id)));
      veh.luggage = veh.luggage.filter((bag) => !t.bookingIds.includes(bag.bookingId));
      veh.exclusive = false;
    }
    for (const item of group) {
      item.arrivedHotel = true;
      item.journey = "at_hotel";
      item.bagWhere = item.bags > 0 ? "porte" : "done";
      for (const p of item.party) {
        p.onboard = false;
        p.visible = true;
        p.path = [];
        p.goalKey = "";
        p.x = SPOT.porteGuest.x + 0.5;
        p.y = SPOT.porteGuest.y + 0.5;
      }
      const late = nowAbs(s) - (item.arrivalAbs + item.delayMin);
      if (late > 20) {
        item.satisfaction.transfer = clampScore(item.satisfaction.transfer - 12);
        item.notes.push("接驳比约定晚到");
      } else {
        item.satisfaction.transfer = clampScore(item.satisfaction.transfer + 6);
        item.notes.push("接驳准时");
      }
      const price = transferPrice(item);
      if (price > 0) postCharge(s, item, `xfer:${item.id}`, item.transfer === "private" ? "专车接送" : "拼车接送", price);
      else if (item.transfer !== "self") {
        item.folio.push({
          id: `xfer0:${item.id}`,
          label: item.transfer === "private" ? "专车接送（已含）" : "接驳（已含）",
          amount: 0,
          cost: 0,
          dedupe: `xfer0:${item.id}`,
        });
      }
      postCost(s, `xfer-cost:${item.id}:in`, "接驳去程", CONFIG.transferCost, item.id);
      keepPromise(item, item.transfer === "private" ? "private_transfer" : "transfer", null, "已送达酒店");
      s.seen.arrive = true;
      log(s, `${item.party[0]?.name ?? "客人"} 抵达岚庭·澄金`);
    }
    t.statusText = "客人已到店";
  }
  if (ph.key === "board-out" && veh) {
    const pax = group.flatMap((item) => item.party);
    veh.passengers = pax.map((p) => p.id);
    veh.luggage = group.filter((item) => item.bags > 0).map((item) => ({ bookingId: item.id, count: item.bags }));
    for (const item of group) {
      for (const p of item.party) p.onboard = true;
      item.bagWhere = "vehicle";
    }
    t.statusText = "客人已上车离店";
  }
  if (ph.key === "handed") {
    if (veh) {
      veh.passengers = [];
      veh.luggage = veh.luggage.filter((bag) => !t.bookingIds.includes(bag.bookingId));
      veh.exclusive = false;
    }
    for (const item of group) {
      postCost(s, `xfer-cost:${item.id}:out`, "接驳返程", CONFIG.transferCost, item.id);
      const late = nowAbs(s) - item.stationAbs;
      if (late > 12) {
        item.satisfaction.departure = clampScore(item.satisfaction.departure - 12);
        item.notes.push("送到车站的时间晚于约定");
      } else {
        item.satisfaction.departure = clampScore(item.satisfaction.departure + 6);
        item.notes.push("按时送到离店地点");
      }
      item.bagWhere = "done";
      finishJourney(s, item);
    }
    t.statusText = "已送到离店地点";
  }
  if (ph.key === "greeted" && b) {
    t.statusText = "已完成迎宾";
    log(s, `礼宾已迎接 ${b.party[0]?.name ?? "客人"}`);
  }
  if (ph.key === "checked-in" && b) {
    const room = roomOf(s, b.roomId);
    if (room) {
      room.status = "occupied";
      room.occupiedBy = b.id;
    }
    b.checkedIn = true;
    b.journey = "in_house";
    b.arrivalWait = Math.max(b.arrivalWait, 0);
    if (b.arrivalWait > 25) {
      b.satisfaction.arrival = clampScore(b.satisfaction.arrival - 10);
      b.notes.push("前台等待较久");
    } else {
      b.satisfaction.arrival = clampScore(b.satisfaction.arrival + 4);
      b.notes.push("入住办理顺利");
    }
    s.seen.checkin = true;
    t.statusText = "入住已办理";
    log(s, `${b.party[0]?.name ?? "客人"} 入住 ${b.roomId}`);
  }
  if (ph.key === "checked-out" && b) {
    postDueNights(s, b);
    settle(s, b);
    const room = roomOf(s, b.roomId);
    if (room) {
      room.status = "dirty";
      room.occupiedBy = null;
      room.turn += 1;
    }
    b.checkedOut = true;
    b.journey = "departing";
    b.dnd = false;
    b.dndAuto = false;
    b.entryOverride = false;
    t.statusText = "账单已结清";
    log(s, `${b.roomId} 已退房，等待清洁`);
  }
  if (ph.key === "bag-in" && b) {
    b.bagWhere = "room";
    s.seen.bag = true;
    t.statusText = "行李已送达";
    log(s, `${b.roomId} 行李已送达`);
  }
  if (ph.key === "bag-porte" && b) {
    b.bagWhere = "porte_out";
    t.statusText = "行李已放到门厅";
    log(s, `${b.party[0]?.name ?? "客人"} 的行李已放到门厅`);
  }
  if (ph.key === "cooked" && b) {
    const cost = (t.tag === "dinner" ? CONFIG.roomServiceCost : CONFIG.breakfastCost) * Math.max(1, b.partySize);
    postCost(s, `cook:${t.id}`, t.tag === "dinner" ? "客房餐食材" : "早餐食材", cost, b.id);
    const where = t.tag === "dinner" || b.pkg === "suite" ? "room" : "restaurant";
    if (!taskExists(s, `serve:${t.dedupeKey}`)) {
      createTask(s, {
        type: "serve",
        bookingIds: [b.id],
        dedupeKey: `serve:${t.dedupeKey}`,
        roomId: b.roomId,
        tag: where === "room" ? "room" : "restaurant",
        prereq: [t.id],
        deadlineAbs: nowAbs(s) + 40,
      });
      const serve = s.tasks[s.tasks.length - 1];
      if (serve) serve.tag = t.tag === "dinner" ? "dinner" : where === "room" ? "room" : "restaurant";
    }
    t.statusText = t.tag === "dinner" ? "客房餐已出餐" : "早餐已出餐";
  }
  if (ph.key === "served" && b) {
    if (t.tag === "dinner") {
      if (!b.folio.some((l) => l.dedupe === `dinner:${b.id}`)) {
        postCharge(s, b, `dinner:${b.id}`, "客房送餐", CONFIG.roomServicePrice);
      }
      b.dinnerDone = true;
      b.satisfaction.dining = clampScore(b.satisfaction.dining + 6);
      b.notes.push("客房送餐送达");
    } else {
      const day = s.time.day;
      if (!b.breakfastDone.includes(day)) b.breakfastDone.push(day);
      keepPromise(b, "breakfast", day, "早餐已送达");
      b.satisfaction.dining = clampScore(b.satisfaction.dining + 8);
      b.folio.push({ id: `bk0:${b.id}:${day}`, label: "早餐（已含）", amount: 0, cost: 0, dedupe: `bk0:${b.id}:${day}` });
      b.notes.push("早餐准时");
    }
    b.eatingUntil = nowAbs(s) + 16;
    b.dishWhere = t.tag === "restaurant" ? "restaurant" : "room";
    b.dishCollected = false;
    s.seen.meal = true;
    t.statusText = t.tag === "dinner" ? "客房餐已送达" : "早餐已送达";
    log(s, t.statusText);
  }
  if (ph.key === "dished" && b) {
    b.dishCollected = true;
    b.dishWhere = "none";
    t.statusText = "餐具已回收";
  }
  if (ph.key === "welcomed" && b) {
    postCost(s, `welcome:${b.id}`, "迎宾礼", CONFIG.welcomeCost, b.id);
    b.welcomeDone = true;
    b.satisfaction.room = clampScore(b.satisfaction.room + (b.preference === "安静" ? 6 : 4));
    keepPromise(b, "welcome", null, "迎宾礼已送达");
    keepPromise(b, "concierge", null, "礼宾已完成到店关怀");
    b.folio.push({ id: `wel0:${b.id}`, label: "迎宾礼（已含）", amount: 0, cost: CONFIG.welcomeCost, dedupe: `wel0:${b.id}` });
    t.statusText = "迎宾礼已送达";
    log(s, `${b.roomId} 迎宾礼已送达`);
  }
  if (ph.key === "cleaned") {
    const room = t.roomId ? roomOf(s, t.roomId) : undefined;
    if (room) room.status = "inspecting";
    t.statusText = "清洁完成，等待检查";
    log(s, `${t.roomId} 清洁完成，等待检查`);
  }
  if (ph.key === "inspected") {
    const room = t.roomId ? roomOf(s, t.roomId) : undefined;
    if (room && room.status !== "ooo") room.status = "clean";
    t.statusText = "检查完成，房间可售";
    log(s, `${t.roomId} 已检查，可以再次出售`);
  }
  if (ph.key === "laundered" && b) {
    postCost(s, `laundry-cost:${b.id}`, "洗衣耗材", CONFIG.laundryCost, b.id);
    if (b.pkg !== "suite") postCharge(s, b, `laundry:${b.id}`, "洗衣", CONFIG.laundryPrice);
    else b.folio.push({ id: `laundry0:${b.id}`, label: "洗衣（已含）", amount: 0, cost: CONFIG.laundryCost, dedupe: `laundry0:${b.id}` });
    b.laundryDone = true;
    t.statusText = "洗衣已完成";
    log(s, `${b.party[0]?.name ?? "客人"} 的洗衣已完成`);
  }
  if (ph.key === "apologized" && b) {
    b.satisfaction.arrival = clampScore(b.satisfaction.arrival + 6);
    b.satisfaction.room = clampScore(b.satisfaction.room + 4);
    b.trust = clampScore(b.trust + 4);
    b.complaintOpen = false;
    b.notes.push("投诉已处理");
    t.statusText = "已向客人致歉";
    log(s, `已处理 ${b.party[0]?.name ?? "客人"} 的投诉`);
  }
}

function advanceTask(s: GameState, t: Task) {
  if (t.status !== "active") return;
  const phases = phaseList(t);
  const ph = phases[t.phase];
  if (!ph) {
    completeTask(s, t);
    return;
  }
  if (ph.op === "gate") {
    const gate = holdReason(s, t);
    if (gate) {
      release(s, t);
      t.status = "waiting";
      t.waitReason = gate;
      t.statusText = gate;
      return;
    }
    t.phase += 1;
    t.phaseMin = 0;
    t.waitReason = "";
    return;
  }
  if (ph.op === "wait_arrival") {
    const group = bookingsOf(s, t);
    const ready = group.every((b) => nowAbs(s) >= b.arrivalAbs + b.delayMin);
    const delayed = group.some((b) => b.delayMin > 0 && nowAbs(s) > b.arrivalAbs && nowAbs(s) < b.arrivalAbs + b.delayMin);
    t.statusText = delayed ? "客人延误，司机等候中" : ready ? "客人已候车" : "客人候车";
    t.waitReason = ready ? "" : t.statusText;
    if (ready) {
      t.phase += 1;
      t.phaseMin = 0;
      t.waitReason = "";
    }
    return;
  }
  if (ph.op === "wait_ready") {
    const b = byId(s, t.bookingId);
    if (!b) return;
    const bagsOk = b.bags === 0 || b.bagWhere === "porte_out" || b.bagWhere === "desk" || b.bagWhere === "done";
    const guestOk = b.party.every((p) => p.onboard || Math.hypot(p.x - (SPOT.porteGuest.x + 0.5), p.y - (SPOT.porteGuest.y + 0.5)) < 1.6);
    if (!bagsOk) {
      t.statusText = b.bagWhere === "room" ? "行李还在房间" : "等待行李";
      t.waitReason = t.statusText;
      return;
    }
    if (!guestOk) {
      t.statusText = "等待客人到门厅";
      t.waitReason = t.statusText;
      return;
    }
    t.phase += 1;
    t.phaseMin = 0;
    t.waitReason = "";
    return;
  }
  if (ph.op === "veh") {
    const veh = vehOf(s, t.vehicleId);
    if (!veh) {
      t.status = "waiting";
      t.waitReason = "等待车辆";
      t.statusText = "等待车辆";
      return;
    }
    const dest = destOf(s, t, ph.dest ?? "depot");
    setGoal(veh, dest, "vehicle");
    const before = veh.path.length;
    moveActor(veh, CONFIG.speed.vehicle);
    if (veh.path.length === before && !at(veh, dest)) {
      veh.goalKey = "";
      setGoal(veh, dest, "vehicle");
      t.idleMin += 1;
      if (t.idleMin > 8 && veh.path.length === 0 && !at(veh, dest)) {
        failTask(s, t, "路线受阻");
        return;
      }
    } else t.idleMin = 0;
    const emp = empOf(s, t.assigneeId);
    if (emp) {
      emp.hidden = true;
      emp.x = veh.x;
      emp.y = veh.y;
    }
    for (const id of veh.passengers) {
      const p = personOf(s, id);
      if (!p) continue;
      p.onboard = true;
      p.visible = false;
      p.x = veh.x;
      p.y = veh.y;
    }
    veh.statusText = ph.text;
    t.statusText = ph.text;
    if (t.type === "pickup") s.seen.car = true;
    if (at(veh, dest)) {
      t.phase += 1;
      t.phaseMin = 0;
      t.idleMin = 0;
    }
    return;
  }
  if (ph.op === "staff") {
    const emp = empOf(s, t.assigneeId);
    if (!emp) {
      t.status = "waiting";
      t.waitReason = `等待${ROLE_LABEL[roleFor(t.type)]}`;
      t.statusText = t.waitReason;
      return;
    }
    emp.hidden = false;
    const dest = destOf(s, t, ph.dest ?? "desk");
    setGoal(emp, dest, "staff");
    moveActor(emp, CONFIG.speed.staff);
    const b = byId(s, t.bookingId);
    const needGuest = (t.type === "check_in" || t.type === "checkout") && ph.dest === "desk";
    const guestThere =
      !needGuest ||
      !b ||
      b.party.every((p) => Math.hypot(p.x - (SPOT.deskGuest.x + 0.5), p.y - (SPOT.deskGuest.y + 0.5)) < 1.5);
    if (at(emp, dest) && guestThere) {
      t.phase += 1;
      t.phaseMin = 0;
      return;
    }
    t.statusText = at(emp, dest) && !guestThere ? "等待客人到前台" : ph.text;
    return;
  }
  if (ph.op === "work") {
    if (ph.key === "cleaned") {
      const room = t.roomId ? roomOf(s, t.roomId) : undefined;
      if (room && room.status === "dirty") room.status = "cleaning";
    }
    const need = workNeed(s, ph.min ?? 1);
    t.phaseMin += 1;
    const pct = Math.min(100, Math.round((t.phaseMin / need) * 100));
    t.statusText = `${ph.text} ${pct}%`;
    if (t.phaseMin >= need) {
      applyKey(s, t);
      if (t.status !== "active") return;
      t.phase += 1;
      t.phaseMin = 0;
      if (t.phase >= phaseList(t).length) completeTask(s, t);
    }
  }
}

function guestGoal(s: GameState, b: Booking): Pt | null {
  if (!b.arrivedHotel || b.departed) return null;
  const now = nowAbs(s);
  const checkout = s.tasks.find((t) => t.type === "checkout" && t.bookingIds.includes(b.id) && t.status === "active" && t.phase >= 1);
  if (checkout && !b.checkedOut) return SPOT.deskGuest;
  const checkin = s.tasks.find((t) => t.type === "check_in" && t.bookingIds.includes(b.id) && t.status === "active" && t.phase >= 1);
  if (checkin && !b.checkedIn) return SPOT.deskGuest;
  if (b.eatingUntil && now < b.eatingUntil && b.dishWhere === "restaurant") return SPOT.restaurant;
  const serve = s.tasks.find((t) => t.type === "serve" && t.bookingIds.includes(b.id) && OPEN.has(t.status) && t.tag === "restaurant");
  if (serve) return SPOT.restaurant;
  if (b.checkedOut && b.transfer === "self") return { x: 1, y: 25 };
  if (b.checkedOut) return SPOT.porteGuest;
  if (b.checkedIn) return roomById(b.roomId).inside;
  return SPOT.bell;
}

function steerGuests(s: GameState) {
  const now = nowAbs(s);
  for (const b of s.bookings) {
    if (b.departed) continue;
    if (b.transfer === "self" && !b.arrivedHotel && now >= b.arrivalAbs) {
      b.arrivedHotel = true;
      b.journey = "at_hotel";
      b.bagWhere = b.bags > 0 ? "porte" : "done";
      for (const p of b.party) {
        p.visible = true;
        p.onboard = false;
        p.path = [];
        p.goalKey = "";
        p.x = SPOT.porteGuest.x + 0.5;
        p.y = SPOT.porteGuest.y + 0.5;
      }
      s.seen.arrive = true;
      log(s, `${b.party[0]?.name ?? "客人"} 自行到店`);
    }
    for (const p of b.party) {
      if (p.onboard) continue;
      if (!b.arrivedHotel) {
        p.visible = b.transfer !== "self";
        continue;
      }
      p.visible = true;
      const goal = guestGoal(s, b);
      if (!goal) continue;
      setGoal(p, goal, "guest");
      moveActor(p, CONFIG.speed.guest);
    }
    if (b.arrivedHotel && !b.checkedIn) b.arrivalWait += 1;
    if (b.checkedOut && b.transfer === "self" && !b.departed) {
      const left = b.party.every((p) => Math.hypot(p.x - 1.5, p.y - 25.5) < 1.2);
      if (left) {
        if (now >= b.stationAbs - 10) {
          b.satisfaction.departure = clampScore(b.satisfaction.departure + 4);
          b.notes.push("客人自行离店");
        }
        b.bagWhere = "done";
        finishJourney(s, b);
      }
    }
  }
}

function finishJourney(s: GameState, b: Booking) {
  if (b.departed) return;
  b.departed = true;
  b.journey = "done";
  for (const p of b.party) {
    p.visible = false;
    p.onboard = false;
  }
  for (const veh of s.vehicles) {
    veh.passengers = veh.passengers.filter((id) => !b.party.some((p) => p.id === id));
    veh.luggage = veh.luggage.filter((bag) => bag.bookingId !== b.id);
  }
  if (!b.settled) settle(s, b);
  writeReview(s, b);
  s.seen.depart = true;
}

function reviewText(b: Booking): string {
  const bits: string[] = [];
  bits.push(b.satisfaction.transfer >= 78 ? "接驳准时" : "接驳等待偏久");
  bits.push(b.satisfaction.arrival >= 78 ? "入住顺利" : "前台等待较久");
  if (b.satisfaction.room >= 86) bits.push("房间舒适，细节到位");
  else if (b.satisfaction.room < 70) bits.push("客房体验一般");
  else bits.push("房间整洁");
  if (b.promises.some((p) => p.kind === "breakfast")) {
    bits.push(b.promises.some((p) => p.kind === "breakfast" && p.status === "failed") ? "早餐未按约定送达" : "早餐准时");
  }
  bits.push(b.satisfaction.departure >= 78 ? "送客准时" : "离店时间有延误");
  if (b.compensated) bits.push("酒店做过补救");
  return bits.join("，");
}

function writeReview(s: GameState, b: Booking) {
  if (b.reviewed) return;
  b.reviewed = true;
  const due = b.folio.reduce((sum, line) => sum + line.amount, 0);
  const stars = Math.max(1, Math.min(5, Math.round((avgScores(b) / 20) * 10) / 10));
  s.ids.review += 1;
  s.reviews.unshift({
    id: `R${s.ids.review}`,
    bookingId: b.id,
    name: b.party[0]?.name ?? "客人",
    kind: b.kind,
    stars,
    scores: { ...b.satisfaction },
    text: reviewText(b),
    day: s.time.day,
  });
  if (s.reviews.length > 40) s.reviews.length = 40;
  let member = b.memberId ? s.members.find((m) => m.id === b.memberId) : s.members.find((m) => m.name === b.party[0]?.name);
  if (!member) {
    s.ids.member += 1;
    member = {
      id: `M${s.ids.member}`,
      name: b.party[0]?.name ?? "会员",
      points: 0,
      stays: 0,
      preference: b.preference,
      trust: b.trust,
      lastStayDay: s.time.day,
    };
    s.members.push(member);
  }
  member.stays += 1;
  member.points += Math.max(0, Math.floor(due / 10));
  member.trust = b.trust;
  member.preference = b.preference;
  member.lastStayDay = s.time.day;
  b.memberId = member.id;
  log(s, `${member.name} 留下 ${stars.toFixed(1)} 分评价，岚金会积分 ${member.points}`);
  if (s.mode === "play" && roll(s, 0, 99) < 18) {
    const again = tryBook(s, {
      kind: b.kind,
      pkg: b.pkg === "suite" && s.policies.sellSuite ? "suite" : b.pkg === "room" ? "room" : s.policies.sellBreakfast ? "breakfast" : "room",
      transfer: b.transfer,
      partySize: b.partySize,
      bags: b.bags,
      roomType: b.roomType,
      arrivalAbs: absOf(s.time.day + 2, 15 * 60),
      nights: 1,
      stationMinute: 11 * 60,
      preference: b.preference,
      names: b.party.map((p) => p.name),
      budgetPerNight: b.budgetPerNight,
    });
    if (again.ok) log(s, `${member.name} 用岚金会档案预订了回访`);
  }
}

function plan(s: GameState) {
  const now = nowAbs(s);
  const waitingPickup = s.bookings.filter(
    (b) =>
      b.transfer !== "self" &&
      !b.arrivedHotel &&
      !b.departed &&
      !b.pickupTaskId &&
      now >= b.pickupNotBefore - 20,
  );
  const used = new Set<string>();
  for (const b of waitingPickup) {
    if (used.has(b.id)) continue;
    const group = [b];
    if (s.policies.allowCarpool && b.transfer === "shared") {
      for (const other of waitingPickup) {
        if (other.id === b.id || used.has(other.id) || other.transfer !== "shared") continue;
        if (Math.abs(other.arrivalAbs - b.arrivalAbs) > CONFIG.carpoolWindow) continue;
        const pax = group.reduce((sum, item) => sum + item.partySize, 0) + other.partySize;
        const bags = group.reduce((sum, item) => sum + item.bags, 0) + other.bags;
        if (pax <= CONFIG.vehicleSeats && bags <= CONFIG.vehicleBags) group.push(other);
      }
    }
    const ids = group.map((item) => item.id);
    const task = createTask(s, {
      type: "pickup",
      bookingIds: ids,
      dedupeKey: `pickup:${[...ids].sort().join("+")}`,
      notBefore: Math.min(...group.map((item) => item.pickupNotBefore)),
      deadlineAbs: Math.min(...group.map((item) => item.arrivalAbs)) + 25,
    });
    for (const item of group) {
      used.add(item.id);
      item.pickupTaskId = task.id;
      if (item.journey === "booked") item.journey = "pickup";
    }
  }

  for (const b of s.bookings) {
    if (b.departed) continue;
    if (b.arrivedHotel && !b.checkedIn && !taskExists(s, `greet:${b.id}`)) {
      createTask(s, { type: "greet", bookingIds: [b.id], dedupeKey: `greet:${b.id}`, deadlineAbs: now + 30 });
    }
    if (b.arrivedHotel && !b.checkedIn && !taskExists(s, `in:${b.id}`)) {
      createTask(s, {
        type: "check_in",
        bookingIds: [b.id],
        dedupeKey: `in:${b.id}`,
        roomId: b.roomId,
        deadlineAbs: b.arrivalAbs + 80,
      });
    }
    if (b.arrivedHotel && b.bags > 0 && b.bagWhere !== "room" && b.bagWhere !== "done" && b.bagWhere !== "vehicle" && !b.checkedOut && !taskExists(s, `bag:${b.id}`)) {
      createTask(s, {
        type: "deliver_bag",
        bookingIds: [b.id],
        dedupeKey: `bag:${b.id}`,
        roomId: b.roomId,
        deadlineAbs: now + 50,
      });
    }
    if (b.checkedIn && !b.welcomeDone && b.promises.some((p) => p.kind === "welcome") && !taskExists(s, `amenity:${b.id}`)) {
      createTask(s, { type: "amenity", bookingIds: [b.id], dedupeKey: `amenity:${b.id}`, roomId: b.roomId, deadlineAbs: now + 80 });
    }
    if (b.checkedIn && !b.checkedOut && !taskExists(s, `out:${b.id}`) && now >= b.checkoutAbs - 8) {
      createTask(s, {
        type: "checkout",
        bookingIds: [b.id],
        dedupeKey: `out:${b.id}`,
        roomId: b.roomId,
        notBefore: b.checkoutAbs,
        deadlineAbs: b.hotelLeaveAbs,
      });
    }
    if (b.checkedOut && b.bags > 0 && (b.bagWhere === "room" || b.bagWhere === "bell") && !taskExists(s, `bagout:${b.id}`)) {
      createTask(s, { type: "collect_bag", bookingIds: [b.id], dedupeKey: `bagout:${b.id}`, roomId: b.roomId, deadlineAbs: b.hotelLeaveAbs });
    }
    if (b.checkedOut && !b.departed && b.transfer !== "self" && !b.dropoffTaskId && now >= b.dropoffNotBefore - 5) {
      const task = createTask(s, {
        type: "dropoff",
        bookingIds: [b.id],
        dedupeKey: `drop:${b.id}`,
        notBefore: b.dropoffNotBefore,
        deadlineAbs: b.stationAbs,
      });
      b.dropoffTaskId = task.id;
    }
    for (const day of b.breakfastDays) {
      if (b.breakfastDone.includes(day)) continue;
      const missed = s.time.day > day || (s.time.day === day && s.time.minute >= 11 * 60);
      const cooking = s.tasks.some(
        (t) => OPEN.has(t.status) && (t.dedupeKey === `cook:bk:${b.id}:${day}` || t.dedupeKey === `serve:cook:bk:${b.id}:${day}`),
      );
      if (missed && !cooking) {
        failPromise(s, b, "breakfast", day, "早餐未在约定时段送出");
        b.breakfastDone.push(day);
        continue;
      }
      if (b.checkedIn && !b.checkedOut && s.time.day === day && s.time.minute >= 7 * 60 + 30 && !taskExists(s, `cook:bk:${b.id}:${day}`)) {
        createTask(s, {
          type: "cook",
          bookingIds: [b.id],
          dedupeKey: `cook:bk:${b.id}:${day}`,
          tag: "breakfast",
          roomId: b.roomId,
          deadlineAbs: absOf(day, 10 * 60 + 30),
        });
      }
    }
    if (
      b.kind === "vip" &&
      b.checkedIn &&
      !b.checkedOut &&
      !b.dinnerDone &&
      s.time.minute >= 18 * 60 &&
      s.time.minute < 20 * 60 + 30 &&
      now < b.checkoutAbs - 40 &&
      !taskExists(s, `cook:dinner:${b.id}`)
    ) {
      createTask(s, {
        type: "cook",
        bookingIds: [b.id],
        dedupeKey: `cook:dinner:${b.id}`,
        tag: "dinner",
        roomId: b.roomId,
        deadlineAbs: now + 70,
      });
    }
    if (
      b.checkedIn &&
      !b.checkedOut &&
      !b.laundryDone &&
      b.kind !== "family" &&
      s.time.minute >= 15 * 60 &&
      s.time.minute < 18 * 60 &&
      now > b.arrivalAbs + 150 &&
      !taskExists(s, `laundry:${b.id}`)
    ) {
      createTask(s, { type: "laundry", bookingIds: [b.id], dedupeKey: `laundry:${b.id}`, roomId: b.roomId, deadlineAbs: now + 120 });
    }
    if (b.checkedIn && !b.checkedOut && b.notes.some((n) => n.includes("未") || n.includes("偏久") || n.includes("晚")) && !taskExists(s, `complaint:${b.id}`) && !b.complaintOpen) {
      b.complaintOpen = true;
      createTask(s, { type: "complaint", bookingIds: [b.id], dedupeKey: `complaint:${b.id}`, deadlineAbs: now + 60 });
    }
    if (b.eatingUntil && now >= b.eatingUntil && !b.dishCollected && !taskExists(s, `dish:${b.id}:${b.eatingUntil}`)) {
      createTask(s, {
        type: "collect_dish",
        bookingIds: [b.id],
        dedupeKey: `dish:${b.id}:${b.eatingUntil}`,
        roomId: b.roomId,
        tag: b.dishWhere === "restaurant" ? "restaurant" : "room",
        deadlineAbs: now + 40,
      });
    }
    if (b.promises.some((p) => p.kind === "welcome" && p.status === "pending") && b.checkedIn && now > b.arrivalAbs + 160 && !b.welcomeDone) {
      failPromise(s, b, "welcome", null, "迎宾礼超时未送达");
      b.welcomeDone = true;
    }
  }

  for (const room of s.rooms) {
    if (room.status === "dirty" && !s.tasks.some((t) => t.type === "clean" && t.roomId === room.id && OPEN.has(t.status))) {
      const key = `clean:${room.id}:${room.turn}`;
      if (!taskExists(s, key)) {
        createTask(s, { type: "clean", dedupeKey: key, roomId: room.id, deadlineAbs: now + 80 });
      }
    }
    if (room.status === "inspecting" && !s.tasks.some((t) => t.type === "inspect" && t.roomId === room.id && OPEN.has(t.status))) {
      const key = `inspect:${room.id}:${room.turn}`;
      if (!taskExists(s, key)) {
        const clean = [...s.tasks].reverse().find((t) => t.type === "clean" && t.roomId === room.id && t.status === "done");
        createTask(s, { type: "inspect", dedupeKey: key, roomId: room.id, prereq: clean ? [clean.id] : [], deadlineAbs: now + 40 });
      }
    }
  }

  const vehicleNeeded = s.tasks.some((t) => (t.type === "pickup" || t.type === "dropoff") && OPEN.has(t.status) && !t.vehicleId);
  if (!vehicleNeeded) {
    for (const veh of s.vehicles) {
      if (veh.taskId) continue;
      if (Math.hypot(veh.x - (SPOT.depotVeh.x + 0.5), veh.y - (SPOT.depotVeh.y + 0.5)) < 1.3) continue;
      if (s.tasks.some((t) => t.type === "return" && t.tag === veh.id && OPEN.has(t.status))) continue;
      createTask(s, { type: "return", dedupeKey: `return:${veh.id}:${Math.floor(now)}`, tag: veh.id, deadlineAbs: now + 50 });
    }
  }
}

function updateDnd(s: GameState) {
  const night = s.time.minute >= 22 * 60 || s.time.minute < 7 * 60 + 20;
  for (const b of s.bookings) {
    if (b.checkedOut || b.departed) {
      b.dnd = false;
      b.dndAuto = false;
      continue;
    }
    if (!b.checkedIn || b.entryOverride) continue;
    const quiet = b.preference === "安静" || b.kind === "vip";
    if (night && quiet) {
      b.dnd = true;
      b.dndAuto = true;
    } else if (b.dndAuto && !night) {
      b.dnd = false;
      b.dndAuto = false;
    }
  }
}

function idleStaff(s: GameState) {
  for (const emp of s.employees) {
    if (emp.taskId || emp.hidden) continue;
    if (emp.path.length === 0 && Math.hypot(emp.x - (emp.home.x + 0.5), emp.y - (emp.home.y + 0.5)) > 0.6) emp.goalKey = "";
    setGoal(emp, emp.home, "staff");
    moveActor(emp, CONFIG.speed.staff * 0.85);
  }
}

function resolveLate(s: GameState) {
  if (s.mode !== "play") return;
  for (const b of s.bookings) {
    if (!b.checkedIn || b.checkedOut || b.lateAsked) continue;
    if (dayOf(b.stationAbs) === s.time.day && s.time.minute === 9 * 60) {
      b.lateAsked = true;
      if (roll(s, 0, 99) < 30) b.lateRequest = b.stationAbs + 90;
    }
    if (b.lateRequest && nowAbs(s) >= b.checkoutAbs - 25) {
      if (s.policies.lateCheckOut) {
        const result = shiftLate(s, b, b.lateRequest);
        b.lateRequest = null;
        log(s, result.ok ? `${b.party[0]?.name ?? "客人"} 的延迟退房已按政策同意` : `${b.party[0]?.name ?? "客人"} 的延迟退房未同意：${result.reason}`);
      } else {
        b.lateRequest = null;
        b.satisfaction.departure = clampScore(b.satisfaction.departure - 4);
        log(s, `已婉拒 ${b.party[0]?.name ?? "客人"} 的延迟退房`);
      }
    }
  }
}

function spawnWave(s: GameState) {
  const afternoon = s.time.minute >= 12 * 60;
  const count = roll(s, 1, 2);
  for (let i = 0; i < count; i++) {
    const rollKind = roll(s, 0, 99);
    const kind = rollKind < 48 ? "business" : rollKind < 78 ? "family" : "vip";
    const name = rngName(s);
    let roomType: Booking["roomType"] = kind === "vip" && s.policies.sellSuite ? "suite" : kind === "family" ? "twin" : "king";
    let party = kind === "business" ? 1 : 2;
    if (kind === "family" && roll(s, 0, 99) < 35 && s.policies.sellSuite) {
      roomType = "suite";
      party = 3;
    }
    if (kind === "vip") party = 2;
    const nights = roll(s, 1, 2);
    const arrivalDay = !afternoon && roll(s, 0, 1) === 0 ? s.time.day : s.time.day + 1;
    const arrivalMin = arrivalDay === s.time.day ? 16 * 60 + roll(s, 0, 40) : roll(s, 10 * 60, 15 * 60);
    let pkg: Booking["pkg"] = "room";
    if (roomType === "suite" && kind === "vip" && s.policies.sellSuite) pkg = "suite";
    else if (s.policies.sellBreakfast && roll(s, 0, 99) < 68) pkg = "breakfast";
    let transfer: Booking["transfer"] = pkg === "suite" ? "private" : roll(s, 0, 99) < 18 ? "self" : "shared";
    if (kind === "business" && roll(s, 0, 99) < 25) transfer = "self";
    const budget = kind === "vip" ? roll(s, 2500, 4200) : kind === "family" ? roll(s, 980, 1500) : roll(s, 1000, 1460);
    const result = tryBook(s, {
      kind,
      pkg,
      transfer,
      partySize: party,
      bags: Math.min(6, party + roll(s, 0, 2)),
      roomType,
      arrivalAbs: absOf(arrivalDay, arrivalMin),
      nights,
      stationMinute: 11 * 60 + roll(s, 0, 40),
      preference: kind === "vip" ? "安静" : kind === "family" ? "家庭便利" : "效率",
      names: [name, ...(party > 1 ? [rngName(s)] : []), ...(party > 2 ? [rngName(s)] : [])],
      budgetPerNight: budget,
      delayMin: roll(s, 0, 99) < 12 ? roll(s, 15, 35) : 0,
    });
    if (!result.ok) log(s, `未能接受${name}的预订：${result.reason}`);
    else log(s, `新预订 ${result.booking.roomId} · ${result.booking.party[0]?.name ?? name} · ${result.booking.nights} 晚`);
  }
}

function closeDay(s: GameState, day: number) {
  if (s.closedDays.includes(day)) return;
  s.closedDays.push(day);
  for (const emp of s.employees) {
    addLedger(s, {
      kind: "wage",
      note: `${emp.name} ${ROLE_LABEL[emp.role]}工资`,
      cashDelta: -CONFIG.wages[emp.role],
      revenueDelta: 0,
      receivableDelta: 0,
      opexDelta: CONFIG.wages[emp.role],
      capexDelta: 0,
      bookingId: null,
      dedupeKey: `wage:${day}:${emp.id}`,
    });
  }
  addLedger(s, {
    kind: "maintenance",
    note: "当日维护",
    cashDelta: -CONFIG.maintenance,
    revenueDelta: 0,
    receivableDelta: 0,
    opexDelta: CONFIG.maintenance,
    capexDelta: 0,
    bookingId: null,
    dedupeKey: `maint:${day}`,
  });
  log(s, `第${day}日日结完成`);
}

function stepOne(s: GameState) {
  s.time.minute += 1;
  if (s.time.minute >= 1440) {
    closeDay(s, s.time.day);
    s.time.minute = 0;
    s.time.day += 1;
  }
  for (const b of s.bookings) postDueNights(s, b);
  updateDnd(s);
  resolveLate(s);
  plan(s);
  assign(s);
  steerGuests(s);
  for (const task of [...s.tasks]) {
    if (task.status === "active") advanceTask(s, task);
  }
  idleStaff(s);
  if (s.mode === "play") {
    const key = `${s.time.day}:${s.time.minute}`;
    if ((s.time.minute === 10 * 60 || s.time.minute === 16 * 60) && !s.spawned.includes(key)) {
      s.spawned.push(key);
      spawnWave(s);
    }
  }
}

export function boot(s: GameState) {
  for (const emp of s.employees) {
    if (emp.taskId && !s.tasks.some((t) => t.id === emp.taskId)) emp.taskId = null;
  }
  for (const veh of s.vehicles) {
    if (veh.taskId && !s.tasks.some((t) => t.id === veh.taskId)) veh.taskId = null;
  }
  plan(s);
  assign(s);
}

export function stepMinutes(s: GameState, n: number) {
  for (let i = 0; i < n; i++) stepOne(s);
}

export function insufficient(s: GameState, cost: number): string | null {
  if (s.cash >= cost) return null;
  return `现金不足，还差 ¥${Math.ceil(cost - s.cash)}`;
}

export function hire(s: GameState, role: Role): { ok: boolean; message: string } {
  const lack = insufficient(s, CONFIG.hireFee);
  if (lack) {
    toast(s, lack);
    return { ok: false, message: lack };
  }
  const name = rngName(s);
  const emp = makeEmployee(s, role, name);
  s.employees.push(emp);
  addLedger(s, {
    kind: "hire",
    note: `聘用${ROLE_LABEL[role]} ${name}`,
    cashDelta: -CONFIG.hireFee,
    revenueDelta: 0,
    receivableDelta: 0,
    opexDelta: CONFIG.hireFee,
    capexDelta: 0,
    bookingId: null,
    dedupeKey: `hire:${emp.id}`,
  });
  const message = `已聘用${ROLE_LABEL[role]} ${name}`;
  toast(s, message);
  return { ok: true, message };
}

export function buyVehicle(s: GameState): { ok: boolean; message: string } {
  if (s.vehicles.length >= CONFIG.maxVehicles) return { ok: false, message: "车位已满" };
  const lack = insufficient(s, CONFIG.vehicleCost);
  if (lack) {
    toast(s, lack);
    return { ok: false, message: lack };
  }
  const veh = makeVehicle(s, `岚庭${["一", "二", "三", "四"][s.vehicles.length] ?? s.vehicles.length + 1}号`, s.vehicles.length);
  s.vehicles.push(veh);
  const ok = postCapex(s, `car:${veh.id}`, `购买接驳车 ${veh.name}`, CONFIG.vehicleCost);
  const message = ok ? `已购买 ${veh.name}` : "购车没有完成";
  if (ok) toast(s, message);
  return { ok, message };
}

export function upgradeComfort(s: GameState): { ok: boolean; message: string } {
  if (s.groupComfort >= 3) return { ok: false, message: "寝具舒适度已到当前上限" };
  const ok = postCapex(s, `comfort:${s.groupComfort + 1}`, "寝具舒适度升级", CONFIG.upgradeComfortCost);
  if (!ok) return { ok: false, message: s.toasts[0]?.text ?? "现金不足" };
  s.groupComfort += 1;
  const message = "寝具已升级。之后的新预订会计入舒适加价，客房评价也会提高。";
  toast(s, message);
  return { ok: true, message };
}

export function upgradeTraining(s: GameState): { ok: boolean; message: string } {
  if (s.training) return { ok: false, message: "团队已经完成跨岗培训" };
  const ok = postCapex(s, "training:1", "跨岗培训", CONFIG.upgradeTrainingCost);
  if (!ok) return { ok: false, message: s.toasts[0]?.text ?? "现金不足" };
  s.training = 1;
  const message = "培训完成。服务更快，礼宾、客房和前台可以互相支援。";
  toast(s, message);
  return { ok: true, message };
}

export function upgradeRoom(s: GameState, roomId: string): { ok: boolean; message: string } {
  const room = roomOf(s, roomId);
  if (!room) return { ok: false, message: "找不到房间" };
  if (room.comfort >= 2) return { ok: false, message: "这间房的舒适度已到上限" };
  const ok = postCapex(s, `room-up:${room.id}:${room.comfort + 1}`, `${room.id} 舒适度升级`, CONFIG.roomUpgradeCost);
  if (!ok) return { ok: false, message: s.toasts[0]?.text ?? "现金不足" };
  room.comfort += 1;
  const message = `${room.id} 已升级，新订单房价和入住评价会提高`;
  toast(s, message);
  return { ok: true, message };
}

export function setOoo(s: GameState, roomId: string, on: boolean): { ok: boolean; message: string } {
  const room = roomOf(s, roomId);
  if (!room) return { ok: false, message: "找不到房间" };
  if (on) {
    if (room.occupiedBy || room.status === "occupied") return { ok: false, message: "住客在店，无法停用" };
    if (room.status === "cleaning" || room.status === "inspecting") return { ok: false, message: "房间正在周转，稍后再停用" };
    room.status = "ooo";
    return { ok: true, message: `${room.id} 已停用，不再接受分配` };
  }
  if (room.status === "ooo") room.status = "clean";
  return { ok: true, message: `${room.id} 已恢复可售` };
}

export function compensate(s: GameState, bookingId: string): { ok: boolean; message: string } {
  const b = byId(s, bookingId);
  if (!b) return { ok: false, message: "找不到订单" };
  if (b.compensated) return { ok: false, message: "这单已经补偿过" };
  const lack = insufficient(s, CONFIG.compensationCost);
  if (lack) {
    toast(s, lack);
    return { ok: false, message: lack };
  }
  postCost(s, `comp:${b.id}`, `服务补救 ${b.party[0]?.name ?? ""}`, CONFIG.compensationCost, b.id);
  b.compensated = true;
  for (const key of Object.keys(b.satisfaction) as (keyof Booking["satisfaction"])[]) {
    b.satisfaction[key] = clampScore(b.satisfaction[key] + 8);
  }
  b.trust = clampScore(b.trust + 5);
  b.notes.push("酒店已作补偿");
  const message = "已记录补偿，体验和信任有所恢复";
  toast(s, message);
  return { ok: true, message };
}

export function allowEntry(s: GameState, bookingId: string): { ok: boolean; message: string } {
  const b = byId(s, bookingId);
  if (!b) return { ok: false, message: "找不到订单" };
  b.dnd = false;
  b.dndAuto = false;
  b.entryOverride = true;
  b.satisfaction.room = clampScore(b.satisfaction.room - 4);
  const message = "已允许入房。若客人原本请勿打扰，客房评价会略降。";
  toast(s, message);
  return { ok: true, message };
}

export function answerLate(s: GameState, bookingId: string, accept: boolean): { ok: boolean; message: string } {
  const b = byId(s, bookingId);
  if (!b || !b.lateRequest) return { ok: false, message: "没有待处理的延迟退房" };
  if (!accept) {
    b.lateRequest = null;
    b.satisfaction.departure = clampScore(b.satisfaction.departure - 4);
    const message = "已婉拒延迟退房";
    toast(s, message);
    return { ok: true, message };
  }
  const result = shiftLate(s, b, b.lateRequest);
  if (!result.ok) {
    toast(s, result.reason);
    return { ok: false, message: result.reason };
  }
  b.lateRequest = null;
  const drop = s.tasks.find((t) => t.id === b.dropoffTaskId && OPEN.has(t.status));
  if (drop) drop.notBefore = b.dropoffNotBefore;
  const out = s.tasks.find((t) => t.dedupeKey === `out:${b.id}` && OPEN.has(t.status));
  if (out) out.notBefore = b.checkoutAbs;
  const message = `已同意延迟退房，新的离店时间 ${clock(minuteOf(b.stationAbs))}`;
  toast(s, message);
  return { ok: true, message };
}

export function prioritize(s: GameState, taskId: string): { ok: boolean; message: string } {
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task || !OPEN.has(task.status)) return { ok: false, message: "这项工作已经结束" };
  task.priorityBoost += 40;
  task.released = true;
  const message = "已提高优先级";
  toast(s, message);
  assign(s);
  return { ok: true, message };
}

export function setRate(s: GameState, type: "king" | "twin" | "suite", value: number): { ok: boolean; message: string } {
  const next = Math.max(CONFIG.rateMin[type], Math.min(CONFIG.rateMax[type], Math.round(value)));
  s.rates[type] = next;
  const message = "已调整未来房价，已确认的订单价格不变";
  toast(s, message);
  return { ok: true, message };
}

export function setPolicy<K extends keyof GameState["policies"]>(s: GameState, key: K, value: GameState["policies"][K]) {
  s.policies[key] = value;
}

export interface Report {
  revenue: number;
  opex: number;
  capex: number;
  nights: number;
  fulfill: number | null;
  kept: number;
  failed: number;
  rating: number | null;
  occ: number;
  cash: number;
  members: number;
  vehicles: number;
  receivable: number;
}

export function report(s: GameState): Report {
  const revenue = s.ledger.reduce((sum, e) => sum + e.revenueDelta, 0);
  const opex = s.ledger.reduce((sum, e) => sum + e.opexDelta, 0);
  const capex = s.ledger.reduce((sum, e) => sum + e.capexDelta, 0);
  const receivable = s.bookings.filter((b) => !b.settled).reduce((sum, b) => sum + b.folio.reduce((a, l) => a + l.amount, 0), 0);
  let kept = 0;
  let failed = 0;
  for (const b of s.bookings) {
    for (const p of b.promises) {
      if (p.status === "kept") kept += 1;
      if (p.status === "failed") failed += 1;
    }
  }
  const rating = s.reviews.length ? s.reviews.reduce((sum, r) => sum + r.stars, 0) / s.reviews.length : null;
  return {
    revenue,
    opex,
    capex,
    nights: s.postedNights.length,
    fulfill: kept + failed === 0 ? null : kept / (kept + failed),
    kept,
    failed,
    rating,
    occ: s.rooms.filter((r) => r.status === "occupied").length,
    cash: s.cash,
    members: s.members.length,
    vehicles: s.vehicles.length,
    receivable,
  };
}

export interface Goal {
  id: string;
  name: string;
  use: string;
  met: boolean;
  lines: string[];
}

export function goals(s: GameState): Goal[] {
  const rep = report(s);
  const rating = rep.rating ?? 0;
  const fulfill = rep.fulfill ?? 0;
  return [
    {
      id: "standard",
      name: "岚庭服务标准",
      use: "确认首店服务标准，开放第二城市考察。考察本身仍在后续版本。",
      met: rep.nights >= 12 && (rep.rating ?? 0) >= 4 && fulfill >= 0.8 && rep.rating !== null,
      lines: [`完成间夜 ${rep.nights}/12`, `评分 ${rep.rating === null ? "尚无评价" : rep.rating.toFixed(1)}/4.0`, `履约 ${rep.kept + rep.failed === 0 ? "尚无完结承诺" : `${Math.round(fulfill * 100)}%`}/80%`],
    },
    {
      id: "loyalty",
      name: "岚金会跨店基础",
      use: "会员偏好、复购和积分会作为未来门店共用档案。",
      met: rep.members >= 5,
      lines: [`会员 ${rep.members}/5`],
    },
    {
      id: "harbor",
      name: "第二家店 · 岚庭港湾",
      use: "在澄湾对岸开店。开业后沿用同一套房间、任务、账单和会员规则。当前版本只累计资格。",
      met: rep.cash >= 80000 && rep.nights >= 40 && rating >= 4.3 && rep.vehicles >= 2,
      lines: [`现金 ${Math.round(rep.cash)}/80000`, `间夜 ${rep.nights}/40`, `评分 ${rep.rating === null ? "尚无" : rep.rating.toFixed(1)}/4.3`, `车辆 ${rep.vehicles}/2`],
    },
    {
      id: "flag",
      name: "国际旗舰与加盟",
      use: "需要三家在营门店之后，才讨论跨国品牌和加盟。现有门店只有澄湾的岚庭·澄金。",
      met: false,
      lines: ["在营门店 1/3", "加盟与跨国网络未开放"],
    },
  ];
}

export function cashEquation(s: GameState): number {
  return CONFIG.startingCash + s.ledger.reduce((sum, e) => sum + e.cashDelta, 0);
}
