import { useEffect, useReducer, useRef, useState, type PointerEvent } from "react";
import { CONFIG, ROLE_LABEL, type Role, type RoomType } from "@/game/config";
import {
  bookingHeadline,
  clock,
  dateLabel,
  journeyLabel,
  kindLabel,
  money,
  pkgLabel,
  roomStatusLabel,
  roomTypeLabel,
} from "@/game/format";
import { consumeTime, createGame, goals, report, stepMinutes } from "@/game/sim";
import {
  allowEntry,
  answerLate,
  buyVehicle,
  compensate,
  hire,
  prioritize,
  setOoo,
  setPolicy,
  setRate,
  upgradeComfort,
  upgradeRoom,
  upgradeTraining,
} from "@/game/sim";
import { boot } from "@/game/sim";
import { tileCenter } from "@/game/map";
import { pickAt, render, type Camera, type Selection } from "@/game/render";
import { clearLocal, loadLocal, saveLocal } from "@/game/save";
import type { GameState } from "@/game/types";
import { BedDouble, Building2, CarFront, ClipboardList, Landmark, Pause, Play, Users } from "lucide-react";

type Tab = "orders" | "staff" | "fleet" | "ops" | "hq";

function fresh(demo = true): GameState {
  const state = createGame({ seed: (Date.now() ^ 20261006) >>> 0, mode: "play", demo });
  boot(state);
  return state;
}

function openingState(): GameState {
  const state = createGame({ seed: 20261006, mode: "play", demo: true });
  boot(state);
  return state;
}

function fitCamera(cam: Camera, width: number, height: number) {
  const focus = tileCenter(24, 14);
  const zoom = width < 760 ? 1.08 : 1.48;
  cam.zoom = zoom;
  cam.x = width / 2 - focus.sx * zoom;
  cam.y = height / 2 - focus.sy * zoom + 12;
}

function clampCamera(cam: Camera, width: number, height: number) {
  if (width < 40 || height < 40) return;
  const focus = tileCenter(24, 14);
  const sx = focus.sx * cam.zoom + cam.x;
  const sy = focus.sy * cam.zoom + cam.y;
  const marginX = Math.min(width * 0.28, 220);
  const marginY = Math.min(height * 0.22, 160);
  if (sx < marginX) cam.x += marginX - sx;
  if (sx > width - marginX) cam.x -= sx - (width - marginX);
  if (sy < marginY) cam.y += marginY - sy;
  if (sy > height - marginY) cam.y -= sy - (height - marginY);
}

export function HotelGame() {
  const [game, setGame] = useState<GameState>(openingState);
  const gameRef = useRef(game);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<Camera>({ ...game.cam });
  const accRef = useRef(0);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const fitted = useRef(false);
  const selRef = useRef<Selection | null>(null);
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const [tab, setTab] = useState<Tab>("orders");
  const [open, setOpen] = useState(true);
  const [sel, setSel] = useState<Selection | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  selRef.current = sel;

  useEffect(() => {
    const saved = loadLocal();
    if (saved) {
      boot(saved);
      gameRef.current = saved;
      camRef.current = { ...saved.cam };
      fitted.current = true;
      setGame(saved);
    } else {
      gameRef.current = gameRef.current ?? game;
    }

    let frame = 0;
    let last = performance.now();
    let saveAcc = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const state = gameRef.current;
      const canvas = canvasRef.current;
      if (state && canvas) {
        const hidden = document.hidden;
        if (!state.paused && !hidden) {
          const stepped = consumeTime(accRef.current, dt, state.speed);
          accRef.current = stepped.acc;
          if (stepped.minutes) {
            stepMinutes(state, stepped.minutes);
            bump();
          }
        }
        const rect = canvas.getBoundingClientRect();
        const dpr = state.quality === "crisp" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        if (!fitted.current && w > 40 && h > 40) {
          fitCamera(camRef.current, w, h);
          fitted.current = true;
        }
        if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
          canvas.width = Math.floor(w * dpr);
          canvas.height = Math.floor(h * dpr);
        }
        const ctx = canvas.getContext("2d");
        if (ctx && w > 1 && h > 1) {
          clampCamera(camRef.current, w, h);
          render(ctx, w, h, state, camRef.current, selRef.current);
        }
        saveAcc += hidden ? 0 : dt;
        if (saveAcc > 20) {
          saveAcc = 0;
          state.cam = { ...camRef.current };
          saveLocal(state);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const canvas = canvasRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas?.getBoundingClientRect();
      const cx = rect ? rect.width / 2 : 0;
      const cy = rect ? rect.height / 2 : 0;
      const next = camRef.current.zoom * (event.deltaY > 0 ? 0.92 : 1.08);
      const zoom = Math.max(0.85, Math.min(2.6, next));
      const scale = zoom / camRef.current.zoom;
      camRef.current.x = cx - (cx - camRef.current.x) * scale;
      camRef.current.y = cy - (cy - camRef.current.y) * scale;
      camRef.current.zoom = zoom;
    };
    canvas?.addEventListener("wheel", onWheel, { passive: false });

    const onHide = () => {
      const state = gameRef.current;
      if (!state) return;
      state.cam = { ...camRef.current };
      saveLocal(state);
      bump();
    };
    document.addEventListener("visibilitychange", onHide);
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const state = gameRef.current;
      if (!state) return;
      if (event.code === "Space") {
        event.preventDefault();
        state.paused = !state.paused;
        bump();
      } else if (event.key === "1") {
        state.speed = 1;
        state.paused = false;
        bump();
      } else if (event.key === "3") {
        state.speed = 3;
        state.paused = false;
        bump();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      canvas?.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("keydown", onKey);
    };
    // opening state is stable for this mount; saves replace the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = game;
  const rep = report(state);
  const chain = goals(state);
  void rev;

  const pointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !gameRef.current) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (event.type === "pointerdown") {
      drag.current = { x, y, cx: camRef.current.x, cy: camRef.current.y, moved: false };
      canvas.setPointerCapture(event.pointerId);
    } else if (event.type === "pointermove" && drag.current) {
      const dx = x - drag.current.x;
      const dy = y - drag.current.y;
      if (Math.hypot(dx, dy) > 5) drag.current.moved = true;
      if (drag.current.moved) {
        camRef.current.x = drag.current.cx + dx;
        camRef.current.y = drag.current.cy + dy;
        canvas.classList.add("is-drag");
      }
    } else if (event.type === "pointerup") {
      canvas.classList.remove("is-drag");
      if (drag.current && !drag.current.moved) {
        const hit = pickAt(gameRef.current, camRef.current, x, y);
        setSel(hit);
        if (hit) setOpen(true);
      }
      drag.current = null;
    }
  };

  const zoomAt = (next: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const cx = rect ? rect.width / 2 : 0;
    const cy = rect ? rect.height / 2 : 0;
    const zoom = Math.max(0.85, Math.min(2.6, next));
    const scale = zoom / camRef.current.zoom;
    camRef.current.x = cx - (cx - camRef.current.x) * scale;
    camRef.current.y = cy - (cy - camRef.current.y) * scale;
    camRef.current.zoom = zoom;
    bump();
  };

  const act = (fn: () => void) => {
    fn();
    bump();
  };

  const booking = sel?.kind === "booking" ? state.bookings.find((b) => b.id === sel.id) : sel?.kind === "room" ? state.bookings.find((b) => b.roomId === sel.id && !b.departed) : undefined;
  const room = sel?.kind === "room" ? state.rooms.find((r) => r.id === sel.id) : booking ? state.rooms.find((r) => r.id === booking.roomId) : undefined;
  const employee = sel?.kind === "employee" ? state.employees.find((e) => e.id === sel.id) : undefined;
  const vehicle = sel?.kind === "vehicle" ? state.vehicles.find((v) => v.id === sel.id) : undefined;

  const tutorial = [
    ["car", "接驳车出发去接沈知夏"],
    ["arrive", "客人抵达门厅"],
    ["checkin", "前台完成入住"],
    ["bag", "行李送到套房"],
    ["meal", "早餐或客房餐送达"],
    ["depart", "送到离店地点并结账"],
  ] as const;
  const nextHint = tutorial.find(([key]) => !state.seen[key]);

  return (
    <main className="lt-shell">
      <header className="flex flex-col gap-1 border-b border-line/40 bg-forest px-3 py-2 text-ivory">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-0">
            <p className="font-display text-xl leading-none tracking-wide">岚庭 · 澄金</p>
            <p className="text-xs text-brass">岚庭国际 · 首店</p>
          </div>
          <p className="text-sm" data-testid="clock">
            {dateLabel(state.time.day, state.time.minute)}
          </p>
          <p className={`text-sm ${state.cash < 1000 ? "text-danger" : "text-ivory"}`} data-testid="cash">
            现金 {money(state.cash)}
          </p>
          <p className="text-sm">入住 {rep.occ}/8</p>
          <p className="text-sm">评分 {rep.rating === null ? "新店" : rep.rating.toFixed(1)}</p>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto">
          <button className="min-h-11 shrink-0 rounded-card bg-canopy px-3 text-sm" onClick={() => act(() => (state.paused = !state.paused))} data-testid="pause">
            {state.paused ? <Play className="inline size-4" /> : <Pause className="inline size-4" />}
            <span className="ml-1">{state.paused ? "继续" : "暂停"}</span>
          </button>
          <button className={`min-h-11 shrink-0 rounded-card px-3 text-sm ${state.speed === 1 && !state.paused ? "bg-gold text-ink" : "bg-canopy"}`} onClick={() => act(() => { state.speed = 1; state.paused = false; })} data-testid="speed-1">
            1倍
          </button>
          <button className={`min-h-11 shrink-0 rounded-card px-3 text-sm ${state.speed === 3 && !state.paused ? "bg-gold text-ink" : "bg-canopy"}`} onClick={() => act(() => { state.speed = 3; state.paused = false; })} data-testid="speed-3">
            3倍
          </button>
          <button className="min-h-11 shrink-0 rounded-card bg-canopy px-3 text-sm" onClick={() => zoomAt(camRef.current.zoom / 1.15)} data-testid="zoom-out">
            缩小
          </button>
          <button className="min-h-11 shrink-0 rounded-card bg-canopy px-3 text-sm" onClick={() => zoomAt(camRef.current.zoom * 1.15)} data-testid="zoom-in">
            放大
          </button>
          <button className="min-h-11 shrink-0 rounded-card bg-gold px-3 text-sm text-ink" onClick={() => setOpen((v) => !v)} data-testid="panel-toggle">
            {open ? "收起" : "面板"}
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <canvas
            ref={canvasRef}
            className="lt-canvas"
            data-testid="hotel-canvas"
            onPointerDown={pointer}
            onPointerMove={pointer}
            onPointerUp={pointer}
          />
          {!state.tutorialDismissed && nextHint && (
            <div className={`absolute left-3 max-w-sm rounded-card border border-line bg-paper p-3 text-ink shadow-lg ${open ? "bottom-[calc(34dvh+0.75rem)] sm:bottom-3" : "bottom-3"}`}>
              <p className="text-xs tracking-widest text-gold">首日引导</p>
              <p className="mt-1 text-sm">{nextHint[1]}。员工会自动领取工作，你可以暂停后查看订单。</p>
              <button className="mt-2 min-h-11 text-sm text-forest" onClick={() => act(() => (state.tutorialDismissed = true))}>
                知道了
              </button>
            </div>
          )}
          {state.toasts[0] && (
            <p className="absolute right-3 top-3 max-w-xs rounded-card bg-paper px-3 py-2 text-sm text-ink" data-testid="toast">
              {state.toasts[0].text}
            </p>
          )}
        </div>

        {open && (
          <aside className="lt-scroll absolute inset-x-0 bottom-0 z-10 flex max-h-[34dvh] w-full flex-col border-t border-line bg-paper text-ink shadow-2xl sm:static sm:inset-auto sm:max-h-none sm:h-auto sm:w-[22rem] sm:max-w-md sm:border-t-0 sm:border-l" data-testid="side-panel">
            <div className="flex gap-1 overflow-x-auto border-b border-line p-2">
              {(
                [
                  ["orders", "订单", ClipboardList],
                  ["staff", "员工", Users],
                  ["fleet", "车辆", CarFront],
                  ["ops", "经营", BedDouble],
                  ["hq", "总部", Landmark],
                ] as const
              ).map(([id, label, Icon]) => (
                <button key={id} className={`flex min-h-11 items-center gap-1 rounded-card px-2 text-sm ${tab === id ? "bg-forest text-ivory" : "bg-ivory"}`} onClick={() => setTab(id)} data-testid={`tab-${id}`}>
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>
            <div className="lt-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
              {tab === "orders" && (
                <div className="space-y-2">
                  {state.bookings.filter((b) => b.journey !== "done").length === 0 && <p className="text-muted">目前没有在店或在途订单。</p>}
                  {state.bookings
                    .filter((b) => b.journey !== "done")
                    .map((b) => (
                      <button key={b.id} className="w-full rounded-card border border-line bg-ivory p-3 text-left" onClick={() => setSel({ kind: "booking", id: b.id })}>
                        <span className="text-xs text-gold">{kindLabel(b.kind)} · {pkgLabel(b.pkg)}</span>
                        <p className="font-medium">{b.party.map((p) => p.name).join("、")}</p>
                        <p>{b.roomId} {roomTypeLabel(b.roomType)} · {bookingHeadline(state, b)}</p>
                      </button>
                    ))}
                  {state.reviews.slice(0, 3).map((review) => (
                    <p key={review.id} className="rounded-card bg-ivory p-3 text-muted">
                      {review.name} {review.stars.toFixed(1)} 分：{review.text}
                    </p>
                  ))}
                </div>
              )}
              {tab === "staff" && (
                <div className="space-y-2">
                  {state.employees.map((emp) => {
                    const task = state.tasks.find((t) => t.id === emp.taskId);
                    return (
                      <button key={emp.id} className="w-full rounded-card border border-line bg-ivory p-3 text-left" onClick={() => setSel({ kind: "employee", id: emp.id })}>
                        <p className="font-medium">{emp.name} · {ROLE_LABEL[emp.role]}</p>
                        <p>{task ? task.statusText || task.waitReason || "执行中" : "待命"}</p>
                      </button>
                    );
                  })}
                  <div className="grid grid-cols-2 gap-2">
                    {(["front", "bell", "house", "driver", "chef"] as Role[]).map((role) => (
                      <button key={role} className="min-h-11 rounded-card bg-forest text-ivory" onClick={() => act(() => hire(state, role))}>
                        聘用{ROLE_LABEL[role]} {money(CONFIG.hireFee)}
                      </button>
                    ))}
                  </div>
                  <p className="text-muted">日薪会在日结扣除。跨岗培训后，礼宾、客房和前台可以支援彼此。</p>
                </div>
              )}
              {tab === "fleet" && (
                <div className="space-y-2">
                  {state.vehicles.map((veh) => (
                    <button key={veh.id} className="w-full rounded-card border border-line bg-ivory p-3 text-left" onClick={() => setSel({ kind: "vehicle", id: veh.id })}>
                      <p className="font-medium">{veh.name}</p>
                      <p>{veh.statusText}</p>
                      <p>乘客 {veh.passengers.length}/{veh.seats} · 行李 {veh.luggage.reduce((sum, bag) => sum + bag.count, 0)}/{veh.luggageCap}</p>
                    </button>
                  ))}
                  <button className="min-h-11 w-full rounded-card bg-forest text-ivory" onClick={() => act(() => buyVehicle(state))} data-testid="buy-car">
                    购买接驳车 {money(CONFIG.vehicleCost)}
                  </button>
                  <p className="text-muted">每辆车 6 个座位、8 件行李。专车不拼车，普通接驳会在时间接近且容量允许时合并。</p>
                </div>
              )}
              {tab === "ops" && (
                <Ops state={state} act={act} />
              )}
              {tab === "hq" && (
                <div className="space-y-3">
                  <p>首店累计房费与服务收入 {money(rep.revenue)}。运营费用 {money(rep.opex)}，设施投资 {money(rep.capex)}。应收 {money(rep.receivable)}。</p>
                  <p>完成间夜 {rep.nights} · 履约 {rep.fulfill === null ? "尚无完结承诺" : `${Math.round(rep.fulfill * 100)}%`} · 会员 {rep.members}</p>
                  {chain.map((goal) => (
                    <article key={goal.id} className="rounded-card border border-line bg-ivory p-3">
                      <p className="font-medium">{goal.name}</p>
                      <p className="text-ok">{goal.met ? "已达成" : "未达成"}</p>
                      {goal.lines.map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                      <p className="text-muted">{goal.use}</p>
                    </article>
                  ))}
                </div>
              )}

              {(booking || room || employee || vehicle) && (
                <section className="rounded-card border border-gold bg-ivory p-3" data-testid="detail">
                  {booking && (
                    <>
                      <p className="font-medium">{booking.party.map((p) => p.name).join("、")}</p>
                      <p>{journeyLabel(booking.journey)} · {bookingHeadline(state, booking)}</p>
                      <p>{booking.roomId} {roomTypeLabel(booking.roomType)} · {booking.partySize} 人 · 行李 {booking.bags} 件 · {booking.language}</p>
                      <p>偏好 {booking.preference} · 信任 {booking.trust}</p>
                      <p>到店 {clock(booking.arrivalAbs % 1440)} · 需于 {clock(booking.stationAbs % 1440)} 到达车站</p>
                      <p className="mt-1">服务承诺</p>
                      {booking.promises.map((p) => (
                        <p key={p.id}>{p.kind === "breakfast" ? `早餐·第${p.day}日` : p.kind} · {p.included ? "套餐内" : "另计"} · {p.status === "kept" ? "已履约" : p.status === "failed" ? "未履约" : "进行中"} {p.note}</p>
                      ))}
                      <p className="mt-1">账单 {booking.settled ? "已收" : "未结"}</p>
                      {booking.folio.map((line) => (
                        <p key={line.id}>{line.label} {line.amount ? money(line.amount) : "¥0"}</p>
                      ))}
                      {booking.lateRequest && (
                        <div className="mt-2 flex gap-2">
                          <button className="min-h-11 rounded-card bg-forest px-3 text-ivory" onClick={() => act(() => answerLate(state, booking.id, true))}>同意延迟退房</button>
                          <button className="min-h-11 rounded-card border border-line px-3" onClick={() => act(() => answerLate(state, booking.id, false))}>婉拒</button>
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button className="min-h-11 rounded-card border border-line px-3" onClick={() => act(() => compensate(state, booking.id))}>补偿 {money(CONFIG.compensationCost)}</button>
                        <button className="min-h-11 rounded-card border border-line px-3" onClick={() => act(() => allowEntry(state, booking.id))}>允许入房</button>
                      </div>
                    </>
                  )}
                  {room && (
                    <>
                      <p className="mt-2 font-medium">{room.id} · {roomTypeLabel(room.type)}</p>
                      <p>{roomStatusLabel(room.status)} · 可住 {room.capacity} 人 · 舒适 +{room.comfort}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button className="min-h-11 rounded-card bg-forest px-3 text-ivory" onClick={() => act(() => upgradeRoom(state, room.id))}>升级舒适 {money(CONFIG.roomUpgradeCost)}</button>
                        <button className="min-h-11 rounded-card border border-line px-3" onClick={() => act(() => { const res = setOoo(state, room.id, room.status !== "ooo"); state.toasts.unshift({ id: `m${state.ids.toast++}`, text: res.message }); })}>
                          {room.status === "ooo" ? "恢复可售" : "停用"}
                        </button>
                      </div>
                    </>
                  )}
                  {employee && (
                    <>
                      <p className="font-medium">{employee.name}</p>
                      <p>{ROLE_LABEL[employee.role]} · {employee.taskId ? "正在工作" : "待命"}</p>
                      {state.tasks.filter((t) => t.assigneeId === employee.id || (t.status === "waiting" && t.statusText.includes(ROLE_LABEL[employee.role]))).slice(0, 3).map((t) => (
                        <p key={t.id}>{t.statusText || t.waitReason}</p>
                      ))}
                    </>
                  )}
                  {vehicle && (
                    <>
                      <p className="font-medium">{vehicle.name}</p>
                      <p>{vehicle.statusText}</p>
                      <p>车上乘客 {vehicle.passengers.length} · 行李 {vehicle.luggage.reduce((sum, bag) => sum + bag.count, 0)}</p>
                      {vehicle.passengers.map((id) => {
                        const person = state.bookings.flatMap((b) => b.party).find((p) => p.id === id);
                        return <p key={id}>{person?.name ?? id} 在车上</p>;
                      })}
                    </>
                  )}
                  <div className="mt-2 space-y-1">
                    {state.tasks.filter((t) => (booking && t.bookingIds.includes(booking.id)) || (room && t.roomId === room.id)).filter((t) => t.status === "pending" || t.status === "waiting" || t.status === "active").slice(0, 4).map((t) => (
                      <button key={t.id} className="block min-h-11 text-left text-forest" onClick={() => act(() => prioritize(state, t.id))}>
                        优先：{t.statusText || t.waitReason || t.type}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <div className="flex flex-wrap gap-2 pt-2">
                <button className="min-h-11 rounded-card border border-line px-3" onClick={() => { state.cam = { ...camRef.current }; saveLocal(state); act(() => state.toasts.unshift({ id: "save", text: "已保存到这台浏览器" })); }} data-testid="save">
                  保存
                </button>
                <button className="min-h-11 rounded-card border border-line px-3" onClick={() => {
                  const loaded = loadLocal();
                  if (!loaded) {
                    state.toasts.unshift({ id: "nosave", text: "没有可继续的存档" });
                    bump();
                    return;
                  }
                  boot(loaded);
                  gameRef.current = loaded;
                  camRef.current = { ...loaded.cam };
                  fitted.current = true;
                  setSel(null);
                  setGame(loaded);
                }} data-testid="continue">
                  继续
                </button>
                <button className="min-h-11 rounded-card border border-line px-3 text-danger" onClick={() => setConfirmReset(true)} data-testid="restart">
                  重新开始
                </button>
              </div>
              <p className="text-xs text-muted">拖动查看酒店，滚轮缩放。点选客人、房间、员工或车。空格暂停。一个游戏日约 5 分钟。</p>
              <ul className="space-y-1 text-xs text-muted">
                {state.log.slice(0, 6).map((line, index) => (
                  <li key={`${line.abs}-${index}`}>{dateLabel(Math.floor(line.abs / 1440) + 1, line.abs % 1440)} {line.text}</li>
                ))}
              </ul>
            </div>
          </aside>
        )}
      </div>
      {confirmReset && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-forest/70 p-4">
          <div className="max-w-sm rounded-card bg-paper p-4 text-ink">
            <p className="font-medium">重新开始会清除这家澄金的本地进度。</p>
            <div className="mt-3 flex gap-2">
              <button className="min-h-11 rounded-card bg-forest px-3 text-ivory" onClick={() => {
                clearLocal();
                const next = fresh(true);
                gameRef.current = next;
                const rect = canvasRef.current?.getBoundingClientRect();
                if (rect && rect.width > 40) fitCamera(camRef.current, rect.width, rect.height);
                else camRef.current = { ...next.cam };
                fitted.current = true;
                setSel(null);
                setConfirmReset(false);
                setGame(next);
              }}>确认重开</button>
              <button className="min-h-11 rounded-card border border-line px-3" onClick={() => setConfirmReset(false)}>留下</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Ops({ state, act }: { state: GameState; act: (fn: () => void) => void }) {
  const rep = report(state);
  return (
    <div className="space-y-3">
      <p>未来房价只影响新订单。舒适度每级加价 {money(CONFIG.comfortPremium)}。</p>
      {(["king", "twin", "suite"] as RoomType[]).map((type) => (
        <label key={type} className="block">
          {roomTypeLabel(type)} {money(state.rates[type])}
          <input
            className="mt-1 w-full accent-forest"
            type="range"
            min={CONFIG.rateMin[type]}
            max={CONFIG.rateMax[type]}
            value={state.rates[type]}
            onChange={(event) => act(() => setRate(state, type, Number(event.target.value)))}
          />
        </label>
      ))}
      <label className="flex min-h-11 items-center justify-between gap-3"><span>允许提前入住</span><input type="checkbox" checked={state.policies.earlyCheckIn} onChange={(event) => act(() => setPolicy(state, "earlyCheckIn", event.target.checked))} /></label>
      <label className="flex min-h-11 items-center justify-between gap-3"><span>允许延迟退房</span><input type="checkbox" checked={state.policies.lateCheckOut} onChange={(event) => act(() => setPolicy(state, "lateCheckOut", event.target.checked))} /></label>
      <label className="flex min-h-11 items-center justify-between gap-3"><span>普通接驳可拼车</span><input type="checkbox" checked={state.policies.allowCarpool} onChange={(event) => act(() => setPolicy(state, "allowCarpool", event.target.checked))} /></label>
      <label className="flex min-h-11 items-center justify-between gap-3"><span>员工自动领任务</span><input type="checkbox" checked={state.policies.autoAssign} onChange={(event) => act(() => setPolicy(state, "autoAssign", event.target.checked))} /></label>
      <label className="flex min-h-11 items-center justify-between gap-3"><span>出售含早餐</span><input type="checkbox" checked={state.policies.sellBreakfast} onChange={(event) => act(() => setPolicy(state, "sellBreakfast", event.target.checked))} /></label>
      <label className="flex min-h-11 items-center justify-between gap-3"><span>出售套房礼宾</span><input type="checkbox" checked={state.policies.sellSuite} onChange={(event) => act(() => setPolicy(state, "sellSuite", event.target.checked))} /></label>
      <button className="min-h-11 w-full rounded-card bg-forest text-ivory" onClick={() => act(() => upgradeComfort(state))} data-testid="upgrade-comfort">
        寝具舒适度 {state.groupComfort}/3 · {money(CONFIG.upgradeComfortCost)}
      </button>
      <button className="min-h-11 w-full rounded-card bg-forest text-ivory" onClick={() => act(() => upgradeTraining(state))}>
        {state.training ? "跨岗培训已完成" : `跨岗培训 ${money(CONFIG.upgradeTrainingCost)}`}
      </button>
      <p className="text-muted">今日收入口径：累计收入 {money(rep.revenue)}，运营 {money(rep.opex)}，投资 {money(rep.capex)}。</p>
      <label className="flex min-h-11 items-center justify-between">
        <span>画面</span>
        <select className="min-h-11 rounded-card border border-line bg-ivory px-2" value={state.quality} onChange={(event) => act(() => (state.quality = event.target.value as GameState["quality"]))}>
          <option value="crisp">清晰像素</option>
          <option value="smooth">省电</option>
        </select>
      </label>
      <p className="flex items-center gap-1 text-muted"><Building2 className="size-4" /> 停用房不计入可售。脏房、检查中和人数超限不会被分配。</p>
    </div>
  );
}
