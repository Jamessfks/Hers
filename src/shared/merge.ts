/**
 * Deep merge, used for every configuration write.
 *
 * Lives in `shared` and imports nothing, so it can be tested without booting
 * Electron. That matters more than it looks: this function sits under every
 * settings change in the app, and its failure mode is silent. A merge that
 * replaces instead of merging does not throw — it just quietly wipes the
 * sibling keys of whatever you edited, and you find out later when Anna has
 * forgotten which voice she uses.
 *
 * Arrays are treated as scalars rather than merged element-wise. `quietHours`
 * is `[1, 8]`, and element-wise merging a two-element array over a two-element
 * array is either a no-op or a bug waiting for the day someone writes `[23]`.
 *
 * `null` and `undefined` mean different things, and conflating them is how you
 * end up with a setting that cannot be switched off. `undefined` is "this patch
 * says nothing about that key"; `null` is "clear it". `quietHours: null` is a
 * legal, meaningful config value — it means Anna never goes quiet — and merging
 * it as if it were absent makes that unreachable from the settings window.
 */

type Mergeable = Record<string, unknown>;

export function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (patch === null) return null as T;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;

  const out = { ...(base as Mergeable) };
  for (const [key, value] of Object.entries(patch as Mergeable)) {
    // Guard against prototype pollution: config JSON is a file on disk, and a
    // file on disk is something a user can be talked into replacing.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = merge(out[key], value);
  }
  return out as T;
}
