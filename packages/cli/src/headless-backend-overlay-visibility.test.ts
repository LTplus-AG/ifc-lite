/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HeadlessBackend.query.entities()`/`entityData()` read only
 * `store.entityIndex`, the parsed file's immutable index.
 * `StoreEditor.addEntity()` / `removeEntity()` deliberately never touch that
 * index (mutations/store-editor.ts) — writes live only in the
 * `MutablePropertyView` overlay this same backend already creates for
 * `bim.mutate.*` / `bim.export.ifc()`. So a session that did
 * `bim.store.addEntity(...)` and then `bim.query()` to confirm was told its
 * own write had not happened, and a session that did
 * `bim.store.removeEntity(ref)` and then `bim.query()` still got the entity
 * back.
 *
 * `@ifc-lite/mcp`'s parallel `HeadlessLikeBackend` already folds its overlay
 * into every read for exactly this reason (#2004, #2014) — this backend did
 * not, so the same script produced different query results depending on
 * whether it ran under the CLI or under MCP. Fixed by reading
 * `MutablePropertyView.getNewEntities()` / `isDeleted()` (the overlay's own
 * public API, already imported here) alongside `store.entityIndex`.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHeadlessContext } from './loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../apps/viewer/public/samples/building-architecture.ifc');

describe('HeadlessBackend query overlay visibility', () => {
  it('a newly added IfcWall is visible to bim.query() in the same session', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const before = bim.query().byType('IfcWall').toArray();

    const ref = bim.store.addEntity('default', {
      type: 'IfcWall',
      attributes: ["2N1x3zzzzzzzzzzzzzzzzz", null, "'ProvenWall'", null, null, null, null, null, null],
    });

    const after = bim.query().byType('IfcWall').toArray();
    expect(after.length).toBe(before.length + 1);
    expect(after.some((e) => e.ref.expressId === ref.expressId && e.name === 'ProvenWall')).toBe(true);
  });

  it('a removed entity disappears from bim.query() in the same session', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const walls = bim.query().byType('IfcWall').toArray();
    expect(walls.length).toBeGreaterThan(0);
    const victim = walls[0];

    bim.store.removeEntity(victim.ref);

    const after = bim.query().byType('IfcWall').toArray();
    expect(after.some((e) => e.ref.expressId === victim.ref.expressId)).toBe(false);
    expect(after.length).toBe(walls.length - 1);
  });
});
