import { CONFIG } from "./config.ts";
import { absOf, dateKey, dayOf } from "./format.ts";
import { createGame, tryBook } from "./factory.ts";
import { ROOMS, SPOT } from "./map.ts";
import { findPath } from "./path.ts";
import { deserialize, serialize } from "./save.ts";
import {
  allowEntry,
  answerLate,
  boot,
  buyVehicle,
  canAssignRoom,
  cashEquation,
  compensate,
  consumeTime,
  hire,
  setRate,
  stepMinutes,
  upgradeComfort,
  upgradeTraining,
} from "./sim.ts";
import type { GameState } from "./types.ts";

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

function check(name: string, fn: () => void): Result {
  try {
    fn();
    return { name, ok: true, detail: "通过" };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function expect(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

function reachable(label: string) {
  for (const room of ROOMS) {
    const guest = findPath(SPOT.deskGuest.x, SPOT.deskGuest.y, room.inside.x, room.inside.y, "guest");
    expect(guest.length > 0, `客人无法从柜台到 ${room.id}（${label}）`);
    const staff = findPath(SPOT.laundry.x, SPOT.laundry.y, room.inside.x, room.inside.y, "staff");
    expect(staff.length > 0, `客房员无法从洗衣房到 ${room.id}`);
    const chef = findPath(SPOT.kitchen.x, SPOT.kitchen.y, SPOT.restaurant.x, SPOT.restaurant.y, "staff");
    expect(chef.length > 0, "厨师无法进入餐厅");
  }
  expect(findPath(SPOT.depotVeh.x, SPOT.depotVeh.y, SPOT.stationVeh.x, SPOT.stationVeh.y, "vehicle").length > 0, "车无法去机场");
  expect(findPath(SPOT.stationVeh.x, SPOT.stationVeh.y, SPOT.porteVeh.x, SPOT.porteVeh.y, "vehicle").length > 0, "车无法回门厅");
  expect(findPath(SPOT.stationGuest.x, SPOT.stationGuest.y, SPOT.porteGuest.x, SPOT.porteGuest.y, "guest").length > 0, "客人无法沿步道走到门厅");
}

function dump(s: GameState): string {
  const b = s.bookings[0];
  const tasks = s.tasks
    .filter((t) => t.status === "active" || t.status === "waiting" || t.status === "pending")
    .map((t) => `${t.type}:${t.status}:${t.statusText || t.waitReason}`)
    .join(" | ");
  return `第${s.time.day}日 ${s.time.minute} 行程 ${b?.journey} 行李 ${b?.bagWhere} 入住 ${b?.checkedIn} 退房 ${b?.checkedOut} 房 ${s.rooms.find((r) => r.id === b?.roomId)?.status} 任务 ${tasks}`;
}

function until(s: GameState, pred: () => boolean, max: number, label: string) {
  for (let i = 0; i < max; i++) {
    if (pred()) return;
    stepMinutes(s, 1);
  }
  throw new Error(`${label} 未在 ${max} 分钟内完成。${dump(s)}`);
}

export function runSelfTest(): Result[] {
  const results: Result[] = [];
  results.push(check("地图可通行", () => reachable("首店")));

  results.push(
    check("完整旅程", () => {
      const s = createGame({ seed: 7, mode: "script", demo: true });
      boot(s);
      const booking = s.bookings[0];
      expect(booking, "没有示范订单");
      until(s, () => !!booking && booking.departed, 3200, "离店");
      expect(booking!.settled, "未结算");
      expect(booking!.bagWhere === "done", `行李状态 ${booking!.bagWhere}`);
      expect(s.vehicles.every((v) => v.passengers.length === 0 && v.luggage.length === 0), "车上仍有人或行李");
      const room = s.rooms.find((r) => r.id === booking!.roomId)!;
      until(s, () => room.status === "clean", 400, "房间恢复可售");
      expect(booking!.folio.some((line) => line.dedupe.startsWith("room:")), "没有房费");
      expect(s.ledger.filter((e) => e.dedupeKey === `settle:${booking!.id}`).length === 1, "结算不是一次");
      expect(Math.round(s.cash) === Math.round(cashEquation(s)), `现金 ${s.cash} 与流水 ${cashEquation(s)} 不符`);
    }),
  );

  results.push(
    check("资源争用", () => {
      const s = createGame({ seed: 8, mode: "script", demo: false });
      const arrival = absOf(1, 11 * 60);
      for (const [roomId, name] of [
        ["101", "顾景行"],
        ["102", "叶清和"],
        ["103", "宋怀瑾"],
      ] as const) {
        const booked = tryBook(s, {
          kind: "business",
          pkg: "room",
          transfer: "private",
          partySize: 1,
          bags: 2,
          roomType: "king",
          arrivalAbs: arrival,
          nights: 1,
          stationMinute: 12 * 60,
          names: [name],
          forceRoomId: roomId,
          budgetPerNight: 3000,
        });
        expect(booked.ok, booked.ok ? "" : booked.reason);
      }
      boot(s);
      until(s, () => s.tasks.some((t) => t.type === "pickup" && t.status === "active"), 500, "第一辆车出发");
      stepMinutes(s, 5);
      const pickups = s.tasks.filter((t) => t.type === "pickup" && t.status !== "done" && t.status !== "cancelled" && t.status !== "exception");
      const active = pickups.filter((t) => t.status === "active");
      expect(active.length === 1, `同时有 ${active.length} 辆车在接客`);
      expect(
        pickups.some((t) => t.waitReason.includes("等待车辆") || t.statusText.includes("等待车辆")),
        `没有订单在等车：${pickups.map((t) => `${t.status}:${t.waitReason || t.statusText}`).join(" / ")}`,
      );
      const owners = s.employees.map((e) => e.taskId).filter(Boolean);
      expect(new Set(owners).size === owners.length, "员工同时领了两项任务");
      const vehOwners = s.vehicles.map((v) => v.taskId).filter(Boolean);
      expect(new Set(vehOwners).size === vehOwners.length, "车辆被重复占用");
    }),
  );

  results.push(
    check("拒绝分配与日期容量", () => {
      const s = createGame({ seed: 9, mode: "script", demo: false });
      const king = s.rooms.find((r) => r.id === "101")!;
      king.status = "dirty";
      expect(!canAssignRoom(king, { party: 1, type: "king", dates: [], mode: "checkin" }).ok, "脏房被分配");
      expect(canAssignRoom(king, { party: 1, type: "king", dates: [], mode: "checkin" }).reason.includes("清洁"), "脏房原因不对");
      king.status = "inspecting";
      expect(canAssignRoom(king, { party: 1, type: "king", dates: [], mode: "checkin" }).reason.includes("检查"), "待检查原因不对");
      king.status = "ooo";
      expect(!canAssignRoom(king, { party: 1, type: "king", dates: [dateKey(3)], mode: "reserve" }).ok, "停用房可售");
      king.status = "clean";
      expect(canAssignRoom(king, { party: 3, type: "king", dates: [], mode: "checkin" }).reason.includes("人数"), "超员未拒绝");
      const first = tryBook(s, {
        kind: "business",
        pkg: "room",
        transfer: "self",
        partySize: 1,
        bags: 1,
        roomType: "king",
        arrivalAbs: absOf(4, 15 * 60),
        nights: 2,
        stationMinute: 11 * 60,
        names: ["韩照野"],
        forceRoomId: "101",
        budgetPerNight: 3000,
      });
      expect(first.ok, "首单应成功");
      const second = tryBook(s, {
        kind: "business",
        pkg: "room",
        transfer: "self",
        partySize: 1,
        bags: 1,
        roomType: "king",
        arrivalAbs: absOf(4, 18 * 60),
        nights: 1,
        stationMinute: 11 * 60,
        names: ["秦一南"],
        forceRoomId: "101",
        budgetPerNight: 3000,
      });
      expect(!second.ok && second.ok === false && second.reason.includes("满"), `日期冲突未拒绝：${second.ok ? "" : second.reason}`);
    }),
  );

  results.push(
    check("等待原因与恢复", () => {
      const s = createGame({ seed: 10, mode: "script", demo: true });
      const booking = s.bookings[0]!;
      booking.delayMin = 25;
      boot(s);
      until(s, () => s.tasks.some((t) => t.type === "pickup" && (t.statusText.includes("候") || t.statusText.includes("延误"))), 80, "抵达机场");
      expect(s.tasks.some((t) => (t.statusText + t.waitReason).includes("候") || (t.statusText + t.waitReason).includes("延误")), "没有候车说明");
      stepMinutes(s, 40);
      expect(s.tasks.some((t) => t.type === "pickup" && (t.status === "active" || t.status === "done")), "延误后没有继续接客");

      const s2 = createGame({ seed: 11, mode: "script", demo: true });
      const b2 = s2.bookings[0]!;
      const room = s2.rooms.find((r) => r.id === b2.roomId)!;
      boot(s2);
      until(s2, () => b2.arrivedHotel, 400, "到店");
      room.status = "dirty";
      stepMinutes(s2, 5);
      const checkin = s2.tasks.find((t) => t.type === "check_in");
      expect(checkin && (checkin.waitReason + checkin.statusText).includes("清洁"), `未显示清洁等待：${checkin?.statusText}/${checkin?.waitReason}`);
      room.status = "clean";
      until(s2, () => b2.checkedIn, 200, "清洁后入住");

      b2.dnd = true;
      b2.dndAuto = false;
      b2.entryOverride = false;
      until(s2, () => s2.tasks.some((t) => (t.type === "amenity" || t.type === "serve") && (t.waitReason.includes("请勿打扰") || t.statusText.includes("请勿打扰"))), 80, "请勿打扰");
      allowEntry(s2, b2.id);
      stepMinutes(s2, 30);
      expect(!s2.tasks.some((t) => t.waitReason === "请勿打扰" && (t.type === "amenity" || t.type === "serve")), "允许入房后仍停在请勿打扰");
    }),
  );

  results.push(
    check("暂停、倍速、跨日与存档", () => {
      expect(consumeTime(0, 30, 0).minutes === 0, "暂停仍在推进");
      const one = consumeTime(0, 300, 1).minutes;
      const three = consumeTime(0, 300, 3).minutes;
      expect(one === 1440, `1 倍速一天应是 1440 分钟，实际 ${one}`);
      expect(three === 4320, `3 倍速应正好三倍，实际 ${three}`);
      const s = createGame({ seed: 12, mode: "script", demo: true });
      boot(s);
      until(s, () => s.time.day === 2, 2000, "进入第二天");
      const wages = s.ledger.filter((e) => e.dedupeKey.startsWith("wage:1:")).length;
      expect(wages === s.employees.length, `日结工资 ${wages}`);
      const raw = serialize(s);
      const loaded = deserialize(raw);
      expect(loaded, "存档无法读取");
      expect(loaded!.ledger.length === s.ledger.length, "读档后流水变了");
      expect(loaded!.cash === s.cash, "读档后现金变了");
      boot(loaded!);
      expect(loaded!.ledger.filter((e) => e.dedupeKey.startsWith("wage:1:")).length === wages, "读档重复发薪");
      const before = loaded!.tasks.length;
      boot(loaded!);
      expect(loaded!.tasks.length === before, "重复生成任务");
      until(loaded!, () => loaded!.bookings[0]?.settled === true, 2500, "结算");
      const settledCash = loaded!.cash;
      const blob = serialize(loaded!);
      const again = deserialize(blob)!;
      boot(again);
      stepMinutes(again, 1);
      expect(again.ledger.filter((e) => e.dedupeKey === `settle:${loaded!.bookings[0]!.id}`).length === 1, "重载后重复结算");
      expect(again.cash === settledCash, "重载后现金被再次改写");
      expect(dayOf(again.bookings[0]!.arrivalAbs) === 1, "入住日丢失");
    }),
  );

  results.push(
    check("招聘升级购车调价补偿", () => {
      const s = createGame({ seed: 13, mode: "script", demo: false });
      const before = s.employees.length;
      const hired = hire(s, "house");
      expect(hired.ok && s.employees.length === before + 1, hired.message);
      expect(s.cash === cashEquation(s), "聘用后现金不平衡");
      s.cash = 100;
      const broke = hire(s, "chef");
      expect(!broke.ok && broke.message.includes("现金不足"), broke.message);
      s.cash = cashEquation(s);
      const comfort = upgradeComfort(s);
      expect(comfort.ok && s.groupComfort === 1, comfort.message);
      const quoteBefore = tryBook(s, {
        kind: "business",
        pkg: "room",
        transfer: "self",
        partySize: 1,
        bags: 1,
        roomType: "king",
        arrivalAbs: absOf(6, 15 * 60),
        nights: 1,
        stationMinute: 11 * 60,
        names: ["陆书衡"],
        budgetPerNight: 5000,
      });
      expect(quoteBefore.ok, "调价前预订失败");
      setRate(s, "king", CONFIG.rateMax.king);
      const quoteAfter = tryBook(s, {
        kind: "business",
        pkg: "room",
        transfer: "self",
        partySize: 1,
        bags: 1,
        roomType: "king",
        arrivalAbs: absOf(8, 15 * 60),
        nights: 1,
        stationMinute: 11 * 60,
        names: ["梁望舒"],
        forceRoomId: "102",
        budgetPerNight: 9000,
      });
      expect(quoteAfter.ok && quoteBefore.ok && quoteAfter.booking.nightly > quoteBefore.booking.nightly, "房价没有影响新订单");
      const rich = createGame({ seed: 14, mode: "script", demo: true });
      const car = buyVehicle(rich);
      expect(car.ok && rich.vehicles.length === 2, car.message);
      expect(upgradeTraining(rich).ok && rich.training === 1, "培训没有生效");
      rich.cash = 10;
      expect(buyVehicle(rich).message.includes("现金不足"), "现金不足没有提示");
      rich.cash = cashEquation(rich);
      const guest = rich.bookings[0]!;
      expect(compensate(rich, guest.id).ok, "补偿失败");
      expect(guest.compensated, "补偿没有记账到订单");
      guest.lateRequest = guest.stationAbs + 60;
      const late = answerLate(rich, guest.id, true);
      expect(late.ok || late.message.includes("冲突"), late.message);
    }),
  );

  results.push(
    check("连续三个游戏日", () => {
      const s = createGame({ seed: 20261006, mode: "play", demo: true });
      boot(s);
      stepMinutes(s, 1440 * 3);
      const doneBy = new Set(s.tasks.filter((t) => t.status === "done").map((t) => t.type));
      for (const role of ["front", "bell", "house", "driver", "chef"] as const) {
        const types =
          role === "front"
            ? ["check_in", "checkout", "complaint"]
            : role === "bell"
              ? ["greet", "deliver_bag", "serve", "amenity"]
              : role === "house"
                ? ["clean", "inspect"]
                : role === "driver"
                  ? ["pickup", "dropoff", "return"]
                  : ["cook"];
        expect(types.some((type) => doneBy.has(type as never)), `${role} 三日内没有完成任务，已完成 ${[...doneBy].join(",")}`);
      }
      expect(Math.round(s.cash) === Math.round(cashEquation(s)), `三日现金 ${s.cash} / 流水 ${cashEquation(s)}`);
      expect(s.ledger.some((e) => e.kind === "wage"), "没有工资");
      expect(s.reviews.length > 0 || s.bookings.some((b) => b.departed), "三日没有完成任何行程");
      expect(s.postedNights.length > 0, "没有记录房晚");
    }),
  );

  return results;
}

const results = runSelfTest();
let failed = 0;
for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} — ${result.detail}`);
  if (!result.ok) failed += 1;
}
if (failed) process.exit(1);
