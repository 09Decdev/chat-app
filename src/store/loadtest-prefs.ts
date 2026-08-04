/**
 * LoadTest prefs — schema-validated localStorage (UI-SPEC-prod-refactor §4 / L-7).
 *
 * `parseLoadtestPrefs` là pure function: validate shape (boolean/string fields,
 * đúng kiểu) → sai shape/JSON hỏng → default im lặng (KHÔNG toast — G-6).
 * Fix failure mode: `'{"requireEnvConfirm":"false"}'` (string truthy) / `null` / `1`
 * → default `true` (an toàn nhất).
 */
export interface LoadtestPrefs {
  requireEnvConfirm: boolean;
}

export const DEFAULT_PREFS: LoadtestPrefs = { requireEnvConfirm: true };

export const PREFS_KEY = 'loadtest.prefs';

export function parseLoadtestPrefs(raw: string | null): LoadtestPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const obj: unknown = JSON.parse(raw);
    if (typeof obj === 'object' && obj !== null) {
      const p = obj as Record<string, unknown>;
      if (typeof p.requireEnvConfirm === 'boolean') return { requireEnvConfirm: p.requireEnvConfirm };
    }
  } catch {
    // fall through → default
  }
  return DEFAULT_PREFS;
}

export function loadPrefs(): LoadtestPrefs {
  return parseLoadtestPrefs(localStorage.getItem(PREFS_KEY));
}

export function savePrefs(p: LoadtestPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // ignore — localStorage có thể đầy/disabled
  }
}