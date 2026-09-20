/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `resolveLiveOwnerHistoryId` (#4857 follow-up, codex review on #5017) —
 * both the viewer's `bim.store` adapter and the CLI/MCP headless backend used
 * to pick `store.entityIndex.byType.get('IFCOWNERHISTORY')?.[0]` directly.
 * That index is the immutable parse-time snapshot: it knows nothing about a
 * `bim.store.removeEntity` tombstone recorded in the overlay, so a script
 * that deletes the model's only `IfcOwnerHistory` and then authors a cost
 * entity got a dead id written into `OwnerHistory` — export omits the
 * tombstoned record, so the reference dangled.
 *
 * The oracle here is `StoreEditor.hasEntity`, the same liveness check
 * `getEntityType`/`hasEntity` themselves use — a resolver that reads it
 * cannot regress independently of whatever the overlay considers "deleted".
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveLiveOwnerHistoryId } from './cost-store-backend.js';

const STEP_LINES = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('cost.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  "ENDSEC;",
  "DATA;",
  "#1=IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);",
  "#2=IFCWALL('0wall00000000000000001',#1,'Exterior wall',$,$,$,$,$,$);",
  "ENDSEC;",
  "END-ISO-10303-21;",
];

async function session(): Promise<{ store: IfcDataStore; editor: StoreEditor }> {
  const bytes = new TextEncoder().encode(STEP_LINES.join('\n'));
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, editor };
}

describe('resolveLiveOwnerHistoryId', () => {
  it('returns the source IfcOwnerHistory id when it is still live', async () => {
    const { store, editor } = await session();
    expect(resolveLiveOwnerHistoryId(store, editor)).toBe(1);
  });

  it('returns null once the only IfcOwnerHistory has been tombstoned in the overlay', async () => {
    const { store, editor } = await session();
    expect(editor.removeEntity(1)).toBe(true);
    expect(resolveLiveOwnerHistoryId(store, editor)).toBeNull();
  });

  it('never hands back a dead id that a cost anchor would export as a dangling reference', async () => {
    const { store, editor } = await session();
    editor.removeEntity(1);
    const resolved = resolveLiveOwnerHistoryId(store, editor);
    // The regression this guards against: before the fix, callers wrote
    // `#1` into every authored cost entity's OwnerHistory even after this
    // removal, and export silently dropped #1 from DATA — a dangling `#1`
    // reference with no definition. `null` is the honest answer instead.
    expect(resolved).not.toBe(1);
    expect(resolved).toBeNull();
  });
});
