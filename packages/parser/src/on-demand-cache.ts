/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from './columnar-parser.js';

/**
 * Memoize an O(entities) on-demand extraction per store. On-demand extractors
 * derive purely from the immutable source + entityIndex, but the viewer calls
 * them on render/stream hot paths where they can re-run once per geometry batch
 * (regression #1404). Caching by store collapses that to one scan per model.
 * Use this for any new `extract*OnDemand` so the whole family stays O(1)-per-call
 * regardless of how often the render layer invokes it.
 */
const onDemandCaches = new WeakMap<IfcDataStore, Map<string, unknown>>();
export function oncePerStore<T>(store: IfcDataStore, key: string, compute: () => T): T {
    let byKey = onDemandCaches.get(store);
    if (!byKey) { byKey = new Map(); onDemandCaches.set(store, byKey); }
    if (byKey.has(key)) return byKey.get(key) as T;
    const value = compute();
    byKey.set(key, value);
    return value;
}
