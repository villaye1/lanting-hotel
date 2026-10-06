import { CONFIG, type Role, type RoomType } from "./config.ts";
import { absOf, clampScore, dateKey, dayOf, minuteOf } from "./format.ts";
import { ROOMS, SPOT } from "./map.ts";
import { trips } from "./path.ts";
import { pick, randInt } from "./rng.ts";
import type { Actor, BookInput, Booking, Employee, GameState, Person, Room, Vehicle } from "./types.ts";

const SURNAMES = ["沈", "周", "林", "陈", "苏", "顾", "江", "叶", "许", "宋", "韩", "秦", "陆", "贺", "梁", "唐", "冯"];
const GIVEN = ["知夏", "晏清", "晚宁", "景行", "予安", "清和", "明珠", "嘉树", "怀瑾", "书衡", "听澜", "婉清", "承泽", "一南", "照野", "望舒"];

function blankActor(x: number, y: number): Actor {
  return { x: x + 0.5, y: y + 0.5, dir: 2, frame: 0, walk: 0, path: [], goalKey: "" };
}

function homes(role: Role) {
  switch (role) {
    case "front":
      return SPOT.deskStaff;
    case "bell":
      return SPOT.bell;
    case "house":
      return SPOT.laundry;
    case "driver":
      return SPOT.depotStaff;
    case "chef":
      return SPOT.kitchen;
  }
}

export function makeEmployee(s: GameState, role: Role, name: string): Employee {
  s.ids.emp += 1;
  const home = homes(role);
  return {
    ...blankActor(home.x, home.y),
    id: `E${s.ids.emp}`,
    hotelId: "h1",
    name,
    role,
    skills: [role],
    taskId: null,
    home: { ...home },
    hidden: false,
  };
}

export function makeVehicle(s: GameState, name: string, slot: number): Vehicle {
  s.ids.veh += 1;
  const x = SPOT.depotVeh.x - slot;
  return {
    ...blankActor(x, SPOT.depotVeh.y),
    id: `V${s.ids.veh}`,
    hotelId: "h1",
    name,
    seats: CONFIG.vehicleSeats,
    luggageCap: CONFIG.vehicleBags,
    passengers: [],
    luggage: [],
    exclusive: false,
    taskId: null,
    statusText: "停在后勤车道",
  };
}

function makeRooms(): Room[] {
  return ROOMS.map((g) => ({
    id: g.id,
    hotelId: "h1" as const,
    type: g.type,
    capacity: g.capacity,
    status: "clean" as const,
    occupiedBy: null,
    nights: {},
    comfort: 0,
    turn: 0,
  }));
}

export function canAssignRoom(
  room: Room,
  opts: { party: number; type: RoomType; dates: string[]; mode: "reserve" | "checkin"; ignoreBookingId?: string },
): { ok: boolean; reason: string } {
  if (room.type !== opts.type) return { ok: false, reason: "房型不符" };
  if (opts.party > room.capacity) return { ok: false, reason: "人数超限" };
  if (room.status === "ooo" || room.status === "upgrading") return { ok: false, reason: "房间停用" };
  if (opts.mode === "checkin") {
    if (room.status === "dirty" || room.status === "cleaning") return { ok: false, reason: "房间清洁中" };
    if (room.status === "inspecting") return { ok: false, reason: "房间检查中" };
    if (room.status === "occupied" && room.occupiedBy && room.occupiedBy !== opts.ignoreBookingId) {
      return { ok: false, reason: "房间仍有住客" };
    }
  }
  for (const d of opts.dates) {
    const holder = room.nights[d];
    if (holder && holder !== opts.ignoreBookingId) return { ok: false, reason: "日期已满" };
  }
  return { ok: true, reason: "" };
}

function nightlyOf(s: GameState, room: Room, input: BookInput): number {
  let n = s.rates[input.roomType] + (s.groupComfort + room.comfort) * CONFIG.comfortPremium;
  if (input.pkg === "breakfast" || input.pkg === "suite") n += CONFIG.breakfastPrice * input.partySize;
  if (input.pkg === "suite") n += CONFIG.suitePremium;
  return n;
}

function makePerson(s: GameState, name: string, look: Person["look"], at: { x: number; y: number }): Person {
  s.ids.person += 1;
  return {
    ...blankActor(at.x, at.y),
    id: `P${s.ids.person}`,
    name,
    look,
    onboard: false,
    visible: true,
  };
}

export function tryBook(s: GameState, input: BookInput): { ok: true; booking: Booking } | { ok: false; reason: string } {
  if (input.nights < 1) return { ok: false, reason: "住宿天数无效" };
  if (input.partySize < 1) return { ok: false, reason: "人数无效" };
  const cap = input.roomType === "suite" ? 3 : 2;
  if (input.partySize > cap) return { ok: false, reason: "人数超限" };
  const arrivalDay = dayOf(input.arrivalAbs);
  const dates: string[] = [];
  for (let i = 0; i < input.nights; i++) dates.push(dateKey(arrivalDay + i));
  const candidates = s.rooms.filter((r) => (input.forceRoomId ? r.id === input.forceRoomId : r.type === input.roomType));
  if (!candidates.length) return { ok: false, reason: "房型不符" };
  let chosen: Room | null = null;
  let reason = "该房型在所选日期已满房";
  const ordered = [...candidates].sort((a, b) => (a.status === "clean" ? 0 : 1) - (b.status === "clean" ? 0 : 1));
  for (const room of ordered) {
    const check = canAssignRoom(room, { party: input.partySize, type: input.roomType, dates, mode: "reserve" });
    if (check.ok) {
      chosen = room;
      break;
    }
    reason = check.reason === "日期已满" ? "该房型在所选日期已满房" : check.reason;
  }
  if (!chosen) return { ok: false, reason };
  const nightly = nightlyOf(s, chosen, input);
  if (input.budgetPerNight !== undefined && nightly > input.budgetPerNight) {
    return { ok: false, reason: "超出预算" };
  }
  const trip = trips();
  const stationAbs = absOf(arrivalDay + input.nights, input.stationMinute);
  const hotelLeaveAbs = stationAbs - trip.porteToStation - CONFIG.bufferMinutes;
  const checkoutAbs = hotelLeaveAbs - 70;
  if (checkoutAbs <= input.arrivalAbs + 30) return { ok: false, reason: "到离店时间太近" };

  s.ids.booking += 1;
  const id = `B${s.ids.booking}`;
  for (const d of dates) chosen.nights[d] = id;

  const names = input.names ? [...input.names] : [];
  while (names.length < input.partySize) {
    const sur = pick(s.rng, SURNAMES);
    s.rng = sur.state;
    const given = pick(s.rng, GIVEN);
    s.rng = given.state;
    names.push(`${sur.value}${given.value}`);
  }
  const spot = input.transfer === "self" ? SPOT.porteGuest : SPOT.stationGuest;
  const party: Person[] = [];
  for (let i = 0; i < input.partySize; i++) {
    const look: Person["look"] =
      i > 0 && input.kind === "family" && input.partySize >= 3 && i === input.partySize - 1
        ? "child"
        : input.kind === "vip"
          ? "vip"
          : input.kind === "family"
            ? "family"
            : "business";
    const person = makePerson(s, names[i] ?? `客人${i + 1}`, look, spot);
    person.x += i * 0.15;
    if (input.transfer === "self") person.visible = false;
    party.push(person);
  }

  const breakfastDays: number[] = [];
  if (input.pkg === "breakfast" || input.pkg === "suite") {
    for (let i = 0; i < input.nights; i++) breakfastDays.push(arrivalDay + 1 + i);
  }
  const promises: Booking["promises"] = [];
  if (input.transfer !== "self") {
    promises.push({
      id: `${id}-tf`,
      kind: input.transfer === "private" ? "private_transfer" : "transfer",
      included: input.pkg === "suite" || (input.pkg === "breakfast" && input.transfer === "shared"),
      status: "pending",
      day: null,
      note: "",
    });
  }
  if (input.pkg === "suite") {
    promises.push({ id: `${id}-w`, kind: "welcome", included: true, status: "pending", day: null, note: "" });
    promises.push({ id: `${id}-c`, kind: "concierge", included: true, status: "pending", day: null, note: "" });
  }
  for (const day of breakfastDays) {
    promises.push({ id: `${id}-b${day}`, kind: "breakfast", included: true, status: "pending", day, note: "" });
  }

  const booking: Booking = {
    id,
    hotelId: "h1",
    kind: input.kind,
    pkg: input.pkg,
    transfer: input.transfer,
    party,
    partySize: input.partySize,
    bags: input.bags,
    roomId: chosen.id,
    roomType: input.roomType,
    arrivalAbs: input.arrivalAbs,
    nights: input.nights,
    stationAbs,
    hotelLeaveAbs,
    checkoutAbs,
    pickupNotBefore: input.arrivalAbs - trip.depotToStation - 4,
    dropoffNotBefore: hotelLeaveAbs - trip.depotToStation,
    nightly,
    language: input.language ?? "中文",
    preference: input.preference ?? (input.kind === "vip" ? "安静" : input.kind === "family" ? "家庭便利" : "效率"),
    patience: input.patience ?? 70,
    satisfaction: { transfer: 82, arrival: 82, room: 80, dining: 80, departure: 82 },
    trust: input.kind === "vip" ? 70 : 62,
    memberId: null,
    journey: "booked",
    bagWhere: input.transfer === "self" ? "porte" : "station",
    checkedIn: false,
    checkedOut: false,
    settled: false,
    arrivedHotel: false,
    departed: false,
    dnd: false,
    dndAuto: false,
    entryOverride: false,
    delayMin: input.delayMin ?? 0,
    arrivalWait: 0,
    pickupTaskId: null,
    dropoffTaskId: null,
    promises,
    folio: [],
    reviewed: false,
    notes: [],
    breakfastDays,
    breakfastDone: [],
    welcomeDone: false,
    dinnerDone: false,
    laundryDone: false,
    complaintOpen: false,
    compensated: false,
    eatingUntil: null,
    dishWhere: "none",
    dishCollected: true,
    lateRequest: null,
    lateAsked: false,
    createdAbs: (s.time.day - 1) * 1440 + s.time.minute,
    budgetPerNight: input.budgetPerNight ?? nightly,
  };
  booking.satisfaction.room = clampScore(78 + (s.groupComfort + chosen.comfort) * 6);
  s.bookings.push(booking);
  return { ok: true, booking };
}

export function createGame(opts?: { seed?: number; mode?: "play" | "script"; demo?: boolean }): GameState {
  const seed = opts?.seed ?? 20261006;
  const s: GameState = {
    version: CONFIG.saveVersion,
    seed,
    rng: seed >>> 0,
    mode: opts?.mode ?? "play",
    time: { day: CONFIG.startDay, minute: 8 * 60 },
    paused: false,
    speed: 1,
    cash: CONFIG.startingCash,
    hotelId: "h1",
    rates: { ...CONFIG.rates },
    policies: {
      earlyCheckIn: true,
      lateCheckOut: true,
      allowCarpool: true,
      autoAssign: true,
      sellBreakfast: true,
      sellSuite: true,
    },
    training: 0,
    groupComfort: 0,
    rooms: makeRooms(),
    employees: [],
    vehicles: [],
    bookings: [],
    tasks: [],
    ledger: [],
    members: [],
    reviews: [],
    log: [],
    toasts: [],
    tutorialDismissed: false,
    seen: { car: false, arrive: false, checkin: false, bag: false, meal: false, depart: false },
    ids: { task: 100, booking: 1000, ledger: 100, person: 100, review: 100, member: 100, toast: 1, emp: 100, veh: 100 },
    closedDays: [],
    postedNights: [],
    spawned: [],
    quality: "crisp",
    cam: { x: 360, y: -120, zoom: 1.55 },
  };
  s.employees = [
    makeEmployee(s, "front", "林晚宁"),
    makeEmployee(s, "bell", "周礼"),
    makeEmployee(s, "house", "陈洁"),
    makeEmployee(s, "driver", "马驰"),
    makeEmployee(s, "chef", "苏味"),
  ];
  s.vehicles = [makeVehicle(s, "岚庭一号", 0)];
  s.log.push({ abs: 0, text: "岚庭·澄金开始营业。礼宾、前台和接驳车已就位。" });
  if (opts?.demo !== false) {
    const booked = tryBook(s, {
      kind: "vip",
      pkg: "suite",
      transfer: "private",
      partySize: 2,
      bags: 3,
      roomType: "suite",
      arrivalAbs: absOf(1, 9 * 60 + 10),
      nights: 1,
      stationMinute: 11 * 60 + 20,
      language: "中文",
      preference: "安静",
      names: ["沈知夏", "周晏"],
      forceRoomId: "107",
      patience: 84,
      budgetPerNight: 4200,
      delayMin: 0,
    });
    if (booked.ok) {
      s.time.minute = Math.max(8 * 60, minuteOf(booked.booking.pickupNotBefore));
      s.log.unshift({
        abs: (s.time.day - 1) * 1440 + s.time.minute,
        text: "示范订单：贵宾沈知夏将入住套房 107，专车即将出发。",
      });
    }
  }
  return s;
}

export function shiftLate(s: GameState, b: Booking, stationAbs: number): { ok: boolean; reason: string } {
  const room = s.rooms.find((r) => r.id === b.roomId);
  if (!room) return { ok: false, reason: "找不到房间" };
  const trip = trips();
  const hotelLeave = stationAbs - trip.porteToStation - CONFIG.bufferMinutes;
  const depDay = dayOf(b.stationAbs);
  const nextId = room.nights[dateKey(depDay)];
  if (nextId && nextId !== b.id) {
    const next = s.bookings.find((x) => x.id === nextId);
    if (next && next.arrivalAbs < hotelLeave) return { ok: false, reason: "后续预订冲突，无法延迟退房" };
  }
  b.stationAbs = stationAbs;
  b.hotelLeaveAbs = hotelLeave;
  b.checkoutAbs = hotelLeave - 70;
  b.dropoffNotBefore = hotelLeave - trip.depotToStation;
  return { ok: true, reason: "" };
}

export function rngName(s: GameState): string {
  const sur = pick(s.rng, SURNAMES);
  s.rng = sur.state;
  const given = pick(s.rng, GIVEN);
  s.rng = given.state;
  return `${sur.value}${given.value}`;
}

export function roll(s: GameState, min: number, max: number): number {
  const r = randInt(s.rng, min, max);
  s.rng = r.state;
  return r.value;
}
