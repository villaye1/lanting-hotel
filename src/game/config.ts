/** 首店经营参数。时长、价格、工资、耗材、升级都集中在这里。 */
export const CONFIG = {
  saveVersion: 1,
  saveKey: "lanting-hotel-v1",
  hotelId: "h1" as const,
  /** 一个游戏日对应的真实秒数（1 倍速）。 */
  dayRealSeconds: 300,
  startDay: 1,
  startingCash: 12800,

  rates: { king: 880, twin: 820, suite: 1680 },
  rateMin: { king: 520, twin: 480, suite: 1100 },
  rateMax: { king: 1680, twin: 1560, suite: 3600 },

  breakfastPrice: 120,
  breakfastCost: 36,
  suitePremium: 200,
  roomServicePrice: 168,
  roomServiceCost: 48,
  welcomeCost: 56,
  laundryPrice: 80,
  laundryCost: 18,
  transferCost: 46,
  sharedTransferFee: 90,
  privateTransferFee: 260,
  compensationCost: 200,
  comfortPremium: 40,

  wages: { front: 280, bell: 250, house: 240, driver: 270, chef: 310 } as const,
  hireFee: 800,
  maintenance: 150,

  upgradeComfortCost: 2400,
  upgradeTrainingCost: 3000,
  trainingFactor: 0.75,
  roomUpgradeCost: 1800,
  vehicleCost: 9600,
  vehicleSeats: 6,
  vehicleBags: 8,

  speed: { guest: 0.72, staff: 0.82, vehicle: 1.12 },
  cleanMinutes: { king: 26, twin: 28, suite: 40 },
  inspectMinutes: 8,
  checkMinutes: 8,
  cookMinutes: 12,
  loadMinutes: 3,
  greetMinutes: 4,
  amenityMinutes: 4,
  laundryMinutes: 18,
  complaintMinutes: 8,
  dishMinutes: 4,

  standardCheckIn: 14 * 60,
  standardCheckOut: 12 * 60,
  bufferMinutes: 12,
  carpoolWindow: 12,
  earlyComfort: 1,

  maxVehicles: 4,
} as const;

export type Role = "front" | "bell" | "house" | "driver" | "chef";
export type RoomType = "king" | "twin" | "suite";

export const ROLE_LABEL: Record<Role, string> = {
  front: "前台",
  bell: "礼宾",
  house: "客房",
  driver: "司机",
  chef: "厨师",
};

export const ROOM_LABEL: Record<RoomType, string> = {
  king: "大床房",
  twin: "双床房",
  suite: "套房",
};

export const PKG_LABEL = {
  room: "基础住宿",
  breakfast: "含早餐",
  suite: "套房礼宾",
} as const;

export const KIND_LABEL = {
  business: "商务",
  family: "家庭",
  vip: "贵宾",
} as const;
