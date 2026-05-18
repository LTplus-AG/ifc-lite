/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test stubs shared across the lib/ helper test suites. Each
 * helper that walks the IFC attribute graph
 * (placement-core / wall-edit / slab-edit / linear-element-edit /
 * metadata-clone / wall-opening-reassign) wants the same minimal
 * mocks: an in-memory `StoreEditor` that returns overlay entities
 * + records positional writes, a `MutablePropertyView` whose
 * `getPositionalMutationsForEntity` is a no-op, and an
 * `IfcDataStore` shim with a `entityIndex.byType` map for the
 * helpers that scan by type. Centralising them here removes the
 * five-way duplication and keeps the harness consistent when one
 * helper's contract evolves.
 *
 * Production code never imports from this module — the lib/
 * helpers take their dependencies via constructor / parameter so
 * the real `@ifc-lite/mutations` + `@ifc-lite/parser` types slot
 * in at runtime.
 */

import type { reassignWallOpenings } from '../wall-opening-reassign.js';

export interface OverlayEntity {
  expressId: number;
  type: string;
  attributes: unknown[];
}

/**
 * Minimal `StoreEditor` stand-in. Records positional writes by
 * mutating the matching overlay entity's `attributes` array (same
 * effect the real editor has via the property view). `addEntity`
 * mirrors the real editor for tests that exercise creation paths
 * (rotation IfcDirection materialise, etc.).
 */
export class StubStoreEditor {
  private overlay = new Map<number, OverlayEntity>();
  private positional = new Map<number, Map<number, unknown>>();
  private nextId: number;

  constructor(initial: OverlayEntity[]) {
    for (const e of initial) this.overlay.set(e.expressId, e);
    this.nextId = Math.max(0, ...initial.map((e) => e.expressId)) + 1;
  }

  getNewEntity(id: number): OverlayEntity | null {
    return this.overlay.get(id) ?? null;
  }

  setPositionalAttribute(id: number, index: number, value: unknown): void {
    let entry = this.positional.get(id);
    if (!entry) {
      entry = new Map();
      this.positional.set(id, entry);
    }
    entry.set(index, value);
    const ent = this.overlay.get(id);
    if (ent) ent.attributes[index] = value;
  }

  addEntity(type: string, attributes: unknown[]): { expressId: number } {
    const id = this.nextId++;
    this.overlay.set(id, { expressId: id, type, attributes: attributes.slice() });
    return { expressId: id };
  }
}

/**
 * Minimal `MutablePropertyView` stand-in. Returns no positional
 * overrides by default. Tests that need pre-mutation state can
 * call `setPositionalForTest` to seed an override; the helper
 * then reads it back via `getPositionalMutationsForEntity`.
 */
export class StubView {
  private positional = new Map<number, Map<number, unknown>>();

  getPositionalMutationsForEntity(id: number): Map<number, unknown> | null {
    return this.positional.get(id) ?? null;
  }

  setPositionalForTest(id: number, index: number, value: unknown): void {
    let entry = this.positional.get(id);
    if (!entry) {
      entry = new Map();
      this.positional.set(id, entry);
    }
    entry.set(index, value);
  }
}

/**
 * Stub `IfcDataStore` — only the `entityIndex.byType` map is
 * meaningfully populated. `source` is an empty buffer; `byId` is
 * an empty map so the parser-backed source reader (registered via
 * `setSourceAttrsReader` in production) never matches anything,
 * which is correct for overlay-only test fixtures.
 *
 * Pass `byType: new Map([['IFCRELDEFINESBYPROPERTIES', [50]]])`
 * to expose rels for `cloneElementMetadata` /
 * `reassignWallOpenings` style tests.
 */
export function makeStubDataStore(byType: Map<string, number[]> = new Map()): Parameters<typeof reassignWallOpenings>[0] {
  return {
    source: new Uint8Array(),
    entityIndex: { byId: new Map(), byType },
  } as unknown as Parameters<typeof reassignWallOpenings>[0];
}
