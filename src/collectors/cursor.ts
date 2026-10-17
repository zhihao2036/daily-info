import type { Json } from '../domain/contracts';

export function resumeCursor(stored: Json): Json {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return stored;
  const state = stored as Record<string, Json>;
  return state.resume ?? state.highWater ?? null;
}
