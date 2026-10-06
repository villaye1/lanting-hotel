import { CONFIG } from "./config.ts";
import type { GameState } from "./types.ts";

export function serialize(state: GameState): string {
  return JSON.stringify({ v: CONFIG.saveVersion, savedAt: Date.now(), state });
}

export function deserialize(raw: string): GameState | null {
  try {
    const data = JSON.parse(raw) as { v?: number; state?: GameState };
    if (!data || data.v !== CONFIG.saveVersion || !data.state) return null;
    const state = data.state;
    if (!state.rooms || !state.bookings || !state.tasks || !state.employees || !state.vehicles || !state.ledger) return null;
    state.version = CONFIG.saveVersion;
    if (!state.toasts) state.toasts = [];
    if (!state.cam) state.cam = { x: 360, y: -120, zoom: 1.55 };
    return state;
  } catch {
    return null;
  }
}

export function saveLocal(state: GameState) {
  if (typeof localStorage === "undefined") return;
  const raw = serialize(state);
  const prev = localStorage.getItem(CONFIG.saveKey);
  if (prev) localStorage.setItem(`${CONFIG.saveKey}-bak`, prev);
  localStorage.setItem(CONFIG.saveKey, raw);
}

export function loadLocal(): GameState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONFIG.saveKey);
    if (!raw) return null;
    return deserialize(raw);
  } catch {
    return null;
  }
}

export function clearLocal() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(CONFIG.saveKey);
}
