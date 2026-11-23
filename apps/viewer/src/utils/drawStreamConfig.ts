/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readPerfFlagUrlParam } from '@ifc-lite/data';
import {
  DEFAULT_DRAW_STREAM_CONFIG,
  DRAW_STREAM_CONFIG_KEYS,
  resolveDrawStreamConfig,
  type DrawStreamConfig,
  type DrawStreamOverrides,
  type Renderer,
} from '@ifc-lite/renderer';
import { isHugeGeometryEnabled, readRampFlag } from './hugeGeometryConfig.js';

/** What the huge-geometry umbrella turns on: stream, arenas, HLOD and the highlight index (no frame budget). */
export const HUGE_GEOMETRY_DRAW_STREAM: Readonly<DrawStreamConfig> = Object.freeze(
  resolveDrawStreamConfig({ stream: true, arena: true, hlod: true, hlIndex: true }),
);

/**
 * Flat-batch draw stream config (`@ifc-lite/renderer` draw-stream.ts), OFF by
 * default. Read once at renderer init, before geometry streams in:
 *   ?m6.stream=1&m6.hlod=1&m6.arena=1          // URL, one param per key
 *   globalThis.__IFC_LITE_M6__ = { stream: 1, hlodPx: 3 }   // console / harness
 * A key set on the global wins over its URL param; the huge-geometry umbrella
 * (`hugeGeometryConfig.ts`) supplies the base they apply to, and the
 * `perf-draw-stream` PostHog ramp switches the stream when neither is set.
 */
export function getDrawStreamConfig(readFeatureFlag?: (key: string) => unknown): DrawStreamConfig {
  const huge = isHugeGeometryEnabled();
  return resolveDrawStreamConfig(readDrawStreamOverrides(huge, readFeatureFlag), huge ? HUGE_GEOMETRY_DRAW_STREAM : DEFAULT_DRAW_STREAM_CONFIG);
}

/**
 * Hand the flags to a fresh renderer before geometry streams in (the arena
 * needs COPY_SRC at upload). A no-op when every path is off, so the renderer
 * keeps its defaults untouched.
 */
export function configureDrawStream(renderer: Pick<Renderer, 'setDrawStreamConfig'>): boolean {
  const config = getDrawStreamConfig();
  if (!config.stream && !config.hlIndex) return false;
  renderer.setDrawStreamConfig(config);
  console.log(`[Viewport] draw stream on (stream=${config.stream}, arena=${config.arena}, hlod=${config.hlod})`);
  return true;
}

function readDrawStreamOverrides(huge: boolean, readFeatureFlag?: (key: string) => unknown): DrawStreamOverrides {
  const raw = readRampFlag('drawStream', huge, readFeatureFlag);
  const overrides: DrawStreamOverrides = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of DRAW_STREAM_CONFIG_KEYS) overrides[key] = (raw as Record<string, unknown>)[key];
  } else if (raw !== undefined && raw !== null) {
    overrides.stream = raw;
  }
  for (const key of DRAW_STREAM_CONFIG_KEYS) {
    if (overrides[key] !== undefined) continue;
    const param = readPerfFlagUrlParam(`m6.${key}`);
    if (param !== null) overrides[key] = param;
  }
  return overrides;
}
