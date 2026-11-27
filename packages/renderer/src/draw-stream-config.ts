/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Configuration of the flat-batch draw stream (`draw-stream.ts`): the stream
 * itself, its render bundles, shared geometry arenas, far-field HLOD proxies
 * and the entity -> batch highlight index. Everything is off by default; the
 * host passes a resolved config to `Renderer.setDrawStreamConfig` before
 * geometry streams in (the arena needs COPY_SRC on batch buffers at upload).
 */
export interface DrawStreamConfig {
  /** Draw plain opaque whole batches through the stream instead of the per-batch loop. */
  stream: boolean;
  /** Replay per-node render bundles (default on with the stream); off = direct draws. */
  bundles: boolean;
  /** Node cell edge in metres (0 = the scene's chunk cell size). */
  nodeCell: number;
  /** The batch set must hold this long (ms) before the stream engages; streaming loads stay on the loop. */
  settleMs: number;
  /** Far-field HLOD proxies over the chunk cells. */
  hlod: boolean;
  /** A proxy whose simplification error projects below this many CSS px replaces its subtree. */
  hlodPx: number;
  /** Proxy grid resolution per node edge. */
  hlodGrid: number;
  /** Entity -> batch reverse index for selection/hover highlight resync (`batch-highlight.ts`). */
  hlIndex: boolean;
  /** Copy stream batches into shared vertex/index arenas so draws differ only in offsets. */
  arena: boolean;
  /** Target frame ms while the camera moves (0 = off): draws largest-first under an adaptive draw budget. */
  budgetMs: number;
}

export const DEFAULT_DRAW_STREAM_CONFIG: Readonly<DrawStreamConfig> = Object.freeze({
  stream: false, bundles: true, nodeCell: 0, settleMs: 1500, hlod: false, hlodPx: 2, hlodGrid: 24, hlIndex: false, arena: false, budgetMs: 0,
});

/** Raw override values as flags carry them: booleans, numbers or their string spellings. */
export type DrawStreamOverrides = Partial<Record<keyof DrawStreamConfig, unknown>>;

const BOOLEAN_KEYS = ['stream', 'bundles', 'hlod', 'hlIndex', 'arena'] as const;
const NUMBER_KEYS = ['nodeCell', 'settleMs', 'hlodPx', 'hlodGrid', 'budgetMs'] as const;
/** Every config key, for hosts that read one flag per key. */
export const DRAW_STREAM_CONFIG_KEYS: readonly (keyof DrawStreamConfig)[] = [...BOOLEAN_KEYS, ...NUMBER_KEYS];

function parseBoolean(raw: unknown): boolean | undefined {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
  return undefined;
}

function parseNonNegative(raw: unknown): number | undefined {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Resolve overrides over `base` (default: everything off). Unparseable values
 * keep the base value, so a malformed flag can never switch a path on.
 */
export function resolveDrawStreamConfig(overrides: DrawStreamOverrides = {}, base: Readonly<DrawStreamConfig> = DEFAULT_DRAW_STREAM_CONFIG): DrawStreamConfig {
  const config: DrawStreamConfig = { ...base };
  for (const key of BOOLEAN_KEYS) config[key] = parseBoolean(overrides[key]) ?? config[key];
  for (const key of NUMBER_KEYS) config[key] = parseNonNegative(overrides[key]) ?? config[key];
  return config;
}

/** Whether batch highlight resync uses the entity -> batch index (the stream implies it). */
export function drawStreamUsesHighlightIndex(config: Readonly<DrawStreamConfig>): boolean {
  return config.hlIndex || config.stream;
}
