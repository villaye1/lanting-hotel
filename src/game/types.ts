import type { Role, RoomType } from "./config.ts";

export type GuestKind = "business" | "family" | "vip";
export type Pkg = "room" | "breakfast" | "suite";
export type TransferMode = "self" | "shared" | "private";
export type RoomStatus = "clean" | "occupied" | "dirty" | "cleaning" | "inspecting" | "ooo" | "upgrading";
export type Journey = "booked" | "pickup" | "at_hotel" | "in_house" | "departing" | "done";
export type BagWhere = "station" | "vehicle" | "porte" | "bell" | "room" | "desk" | "porte_out" | "done";
export type TaskType =
  | "pickup"
  | "dropoff"
  | "return"
  | "greet"
  | "check_in"
  | "checkout"
  | "deliver_bag"
  | "collect_bag"
  | "cook"
  | "serve"
  | "collect_dish"
  | "amenity"
  | "clean"
  | "inspect"
  | "laundry"
  | "complaint";
export type TaskStatus = "pending" | "waiting" | "active" | "done" | "exception" | "cancelled";
export type Look = "business" | "family" | "vip" | "child" | "front" | "bell" | "house" | "driver" | "chef";

export interface Pt {
  x: number;
  y: number;
}

export interface Actor {
  x: number;
  y: number;
  dir: number;
  frame: number;
  walk: number;
  path: Pt[];
  goalKey: string;
}

export interface Person extends Actor {
  id: string;
  name: string;
  look: Look;
  onboard: boolean;
  visible: boolean;
}

export interface ServicePromise {
  id: string;
  kind: "transfer" | "welcome" | "breakfast" | "concierge" | "private_transfer";
  included: boolean;
  status: "pending" | "kept" | "failed";
  /** 早餐对应的游戏日；其他承诺为空。 */
  day: number | null;
  note: string;
}

export interface FolioLine {
  id: string;
  label: string;
  amount: number;
  cost: number;
  dedupe: string;
}

export interface Scores {
  transfer: number;
  arrival: number;
  room: number;
  dining: number;
  departure: number;
}

export interface Booking {
  id: string;
  hotelId: "h1";
  kind: GuestKind;
  pkg: Pkg;
  transfer: TransferMode;
  party: Person[];
  partySize: number;
  bags: number;
  roomId: string;
  roomType: RoomType;
  arrivalAbs: number;
  nights: number;
  /** 必须到达车站/机场的绝对分钟。 */
  stationAbs: number;
  hotelLeaveAbs: number;
  checkoutAbs: number;
  pickupNotBefore: number;
  dropoffNotBefore: number;
  nightly: number;
  language: string;
  preference: string;
  patience: number;
  satisfaction: Scores;
  trust: number;
  memberId: string | null;
  journey: Journey;
  bagWhere: BagWhere;
  checkedIn: boolean;
  checkedOut: boolean;
  settled: boolean;
  arrivedHotel: boolean;
  departed: boolean;
  dnd: boolean;
  entryOverride: boolean;
  delayMin: number;
  arrivalWait: number;
  lateAsked: boolean;
  dndAuto: boolean;
  pickupTaskId: string | null;
  dropoffTaskId: string | null;
  promises: ServicePromise[];
  folio: FolioLine[];
  reviewed: boolean;
  notes: string[];
  breakfastDays: number[];
  breakfastDone: number[];
  welcomeDone: boolean;
  dinnerDone: boolean;
  laundryDone: boolean;
  complaintOpen: boolean;
  compensated: boolean;
  eatingUntil: number | null;
  dishWhere: "none" | "restaurant" | "room";
  dishCollected: boolean;
  lateRequest: number | null;
  createdAbs: number;
  budgetPerNight: number;
}

export interface Room {
  id: string;
  hotelId: "h1";
  type: RoomType;
  capacity: number;
  status: RoomStatus;
  occupiedBy: string | null;
  /** 脏房周转序号，避免清洁任务重复生成。 */
  turn: number;
  /** 日期键 → 预订号，售出即锁定。 */
  nights: Record<string, string>;
  comfort: number;
}

export interface Employee extends Actor {
  id: string;
  hotelId: "h1";
  name: string;
  role: Role;
  skills: Role[];
  taskId: string | null;
  home: Pt;
  hidden: boolean;
}

export interface VehicleLuggage {
  bookingId: string;
  count: number;
}

export interface Vehicle extends Actor {
  id: string;
  hotelId: "h1";
  name: string;
  seats: number;
  luggageCap: number;
  passengers: string[];
  luggage: VehicleLuggage[];
  exclusive: boolean;
  taskId: string | null;
  statusText: string;
}

export interface Task {
  id: string;
  hotelId: "h1";
  bookingId: string | null;
  bookingIds: string[];
  type: TaskType;
  prereq: string[];
  status: TaskStatus;
  assigneeId: string | null;
  vehicleId: string | null;
  phase: number;
  phaseMin: number;
  createdAbs: number;
  deadlineAbs: number;
  notBefore: number;
  waitReason: string;
  statusText: string;
  priorityBoost: number;
  /** 自动分派关闭时，玩家点名后才可领取。 */
  released: boolean;
  dedupeKey: string;
  roomId: string | null;
  tag: string;
  idleMin: number;
}

export interface LedgerEntry {
  id: string;
  hotelId: "h1";
  abs: number;
  day: number;
  kind: string;
  note: string;
  cashDelta: number;
  revenueDelta: number;
  receivableDelta: number;
  opexDelta: number;
  capexDelta: number;
  bookingId: string | null;
  dedupeKey: string;
}

export interface Member {
  id: string;
  name: string;
  points: number;
  stays: number;
  preference: string;
  trust: number;
  lastStayDay: number;
}

export interface Review {
  id: string;
  bookingId: string;
  name: string;
  kind: GuestKind;
  stars: number;
  scores: Scores;
  text: string;
  day: number;
}

export interface LogLine {
  abs: number;
  text: string;
}

export interface GameState {
  version: number;
  seed: number;
  rng: number;
  mode: "play" | "script";
  time: { day: number; minute: number };
  paused: boolean;
  speed: 1 | 3;
  cash: number;
  hotelId: "h1";
  rates: { king: number; twin: number; suite: number };
  policies: {
    earlyCheckIn: boolean;
    lateCheckOut: boolean;
    allowCarpool: boolean;
    autoAssign: boolean;
    sellBreakfast: boolean;
    sellSuite: boolean;
  };
  training: number;
  groupComfort: number;
  rooms: Room[];
  employees: Employee[];
  vehicles: Vehicle[];
  bookings: Booking[];
  tasks: Task[];
  ledger: LedgerEntry[];
  members: Member[];
  reviews: Review[];
  log: LogLine[];
  toasts: { id: string; text: string }[];
  tutorialDismissed: boolean;
  seen: { car: boolean; arrive: boolean; checkin: boolean; bag: boolean; meal: boolean; depart: boolean };
  ids: {
    task: number;
    booking: number;
    ledger: number;
    person: number;
    review: number;
    member: number;
    toast: number;
    emp: number;
    veh: number;
  };
  closedDays: number[];
  postedNights: string[];
  spawned: string[];
  quality: "crisp" | "smooth";
  cam: { x: number; y: number; zoom: number };
}

export interface BookInput {
  kind: GuestKind;
  pkg: Pkg;
  transfer: TransferMode;
  partySize: number;
  bags: number;
  roomType: RoomType;
  arrivalAbs: number;
  nights: number;
  /** 离店当天必须到达车站的钟点分钟。 */
  stationMinute: number;
  language?: string;
  preference?: string;
  patience?: number;
  budgetPerNight?: number;
  delayMin?: number;
  names?: string[];
  forceRoomId?: string;
}
