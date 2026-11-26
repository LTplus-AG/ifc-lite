/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/a2ui`: A2UI v1.0 for IFC result surfaces.
 *
 * The root entry is plain TypeScript with no A2UI runtime, safe to import
 * eagerly anywhere: ids, trust policy, entity ref encoding, the query spec and
 * deterministic surface builders. The A2UI-backed parts live behind
 * `@ifc-lite/a2ui/catalog` and `@ifc-lite/a2ui/agent`; browsers load those lazily.
 */

export * from './policy.js';
export * from './refs.js';
export * from './query.js';
export * from './builders.js';
export * from './charts.js';
