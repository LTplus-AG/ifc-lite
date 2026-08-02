/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Always-on extraction of IfcAlignment centerlines for the 3D viewport.
 *
 * IfcAlignment carries its geometry in the `Axis` curve (an IfcAlignmentCurve
 * or IfcPolyline), not a `Representation`, so it never produces a mesh in the
 * streaming batch mesher. Instead of rendering it as a triangulated ribbon —
 * which reads as a thin solid strip — the WASM `parseAlignmentLines` API
 * samples the directrix into a flat 3D line-list in renderer Y-up world space,
 * which we feed to `renderer.uploadAlignmentLines3D`. This matches how IfcGrid
 * axes and IfcAnnotation curves render as thin lines.
 *
 * Unlike annotations there is no visibility toggle: alignment lines render
 * whenever a loaded model has alignments. The parse runs once per model source
 * and is cached module-globally, so federated views share one parse per source.
 */

import { useEffect, useMemo, useState } from 'react';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import type { IfcDataStore } from '@ifc-lite/parser';
import { sourceKey } from './source-key.js';
import { hasEntityType } from './has-entity-type.js';

const EMPTY_F32 = new Float32Array(0);

// ─── Shared parse cache ──────────────────────────────────────────────────────
// One WASM walk per model source; cached so re-renders (and federated views
// that share a source) don't re-parse.
const PARSE_CACHE = new Map<string, Float32Array>();
const PARSE_INFLIGHT = new Map<string, Promise<void>>();

type CacheListener = () => void;
const CACHE_LISTENERS = new Set<CacheListener>();
function notifyCacheChange(): void {
  for (const fn of CACHE_LISTENERS) fn();
}

async function parseAlignmentLinesFor(store: IfcDataStore): Promise<Float32Array> {
  const source = store.source;
  if (!source || source.byteLength === 0) return EMPTY_F32;
  // Most models (all buildings) have no alignments. Skip the full-source WASM
  // scan — it copies the entire IFC source into the WASM heap on the main thread
  // just to find none (~0.5s on a 170MB file).
  if (!hasEntityType(store, 'IfcAlignment', 'IfcAlignmentCurve')) return EMPTY_F32;
  const processor = new GeometryProcessor();
  try {
    await processor.init();
    const verts = processor.parseAlignmentLines(source);
    return verts && verts.length > 0 ? verts : EMPTY_F32;
  } finally {
    processor.dispose();
  }
}

function ensureParseFor(stores: IfcDataStore[]): void {
  for (const store of stores) {
    const key = sourceKey(store);
    if (!key) continue;
    if (PARSE_CACHE.has(key)) continue;
    if (PARSE_INFLIGHT.has(key)) continue;

    const promise = (async () => {
      try {
        const verts = await parseAlignmentLinesFor(store);
        PARSE_CACHE.set(key, verts);
        notifyCacheChange();
      } catch (error) {
        // Cache empty on failure so we don't retry a doomed parse every tick.
        // eslint-disable-next-line no-console
        console.warn('[useAlignmentLines3D] parse failed:', error);
        PARSE_CACHE.set(key, EMPTY_F32);
        notifyCacheChange();
      } finally {
        PARSE_INFLIGHT.delete(key);
      }
    })();
    PARSE_INFLIGHT.set(key, promise);
  }
}

/** Read the active store set from the viewer store. Federation-aware. */
function useActiveStores(): IfcDataStore[] {
  const { models, ifcDataStore } = useViewerStore(
    useShallow((s) => ({ models: s.models, ifcDataStore: s.ifcDataStore })),
  );
  return useMemo(() => {
    const out: IfcDataStore[] = [];
    if (models.size > 0) {
      for (const [, m] of models) if (m.ifcDataStore) out.push(m.ifcDataStore);
    } else if (ifcDataStore) {
      out.push(ifcDataStore);
    }
    return out;
  }, [models, ifcDataStore]);
}

/**
 * Sample every loaded model's IfcAlignment centerlines into a single flat
 * `[x0,y0,z0, x1,y1,z1, …]` line-list in renderer world space (Y-up,
 * RTC-subtracted, metres). Returns a stable empty array when no model carries
 * an alignment. Always parses (no toggle) — see the file header.
 */
export function useAlignmentLines3D(): Float32Array {
  const stores = useActiveStores();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    ensureParseFor(stores);
    const listener: CacheListener = () => setVersion((v) => v + 1);
    CACHE_LISTENERS.add(listener);
    return () => {
      CACHE_LISTENERS.delete(listener);
    };
  }, [stores]);

  return useMemo(() => {
    void version; // depend on parse-completion ticks
    const arrays: Float32Array[] = [];
    let total = 0;
    for (const store of stores) {
      const key = sourceKey(store);
      if (!key) continue;
      const cached = PARSE_CACHE.get(key);
      if (cached && cached.length > 0) {
        arrays.push(cached);
        total += cached.length;
      }
    }
    if (total === 0) return EMPTY_F32;
    if (arrays.length === 1) return arrays[0];
    const merged = new Float32Array(total);
    let offset = 0;
    for (const a of arrays) {
      merged.set(a, offset);
      offset += a.length;
    }
    return merged;
  }, [stores, version]);
}
