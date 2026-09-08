/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HeadlessBackend.query.properties()`/`quantities()` read `EntityNode`
 * directly off the parsed store and never consulted the `MutablePropertyView`
 * overlay this same backend already creates for `bim.mutate.*` /
 * `bim.export.ifc()`. So `bim.mutate.setProperty(...)` followed by
 * `bim.properties(ref)` — or `bim.mutate.deleteProperty(...)` followed by the
 * same read — silently returned the pre-edit value in the same session, even
 * though `bim.export.ifc()` on that same session already reflected the edit.
 * Everything built on `bim.properties()`/`bim.quantities()` inherited the
 * staleness: `export --format csv|json`, the `props` command, `query --where`.
 *
 * #3498 folded the overlay into entity add/remove visibility for
 * `query.entities()`/`entityData()` and explicitly left "property/quantity
 * overlay folding" out of scope. Fixed here via `MutablePropertyView`'s own
 * `getForEntity()`/`getQuantitiesForEntity()` (the same merge
 * `StepExporter` already reads for `bim.export.ifc()`), through the new
 * `overlayProperties`/`overlayQuantities` helpers in `query-overlay.ts`.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHeadlessContext } from './loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../apps/viewer/public/samples/building-architecture.ifc');

describe('HeadlessBackend query.properties()/quantities() overlay visibility', () => {
  it('a property set via bim.mutate.setProperty is visible to bim.properties() in the same session', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const wall = bim.query().byType('IfcWall').first();
    expect(wall).toBeTruthy();
    const ref = wall!.ref;

    bim.mutate.setProperty(ref, 'Pset_RoundTripAudit', 'AuditMarker', 'edited-value');

    const props = bim.properties(ref);
    const pset = props.find((p) => p.name === 'Pset_RoundTripAudit');
    expect(pset?.properties.find((p) => p.name === 'AuditMarker')?.value).toBe('edited-value');
  });

  it('a deleted property does not reappear, while its sibling in the same pset stays visible', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const wall = bim.query().byType('IfcWall').first();
    expect(wall).toBeTruthy();
    const ref = wall!.ref;

    bim.mutate.setProperty(ref, 'Pset_RoundTripAudit', 'AuditMarker', 'edited-value');
    bim.mutate.setProperty(ref, 'Pset_RoundTripAudit', 'KeptMarker', 'still-here');
    bim.mutate.deleteProperty(ref, 'Pset_RoundTripAudit', 'AuditMarker');

    const props = bim.properties(ref);
    const pset = props.find((p) => p.name === 'Pset_RoundTripAudit');
    expect(pset?.properties.find((p) => p.name === 'AuditMarker')).toBeUndefined();
    expect(pset?.properties.find((p) => p.name === 'KeptMarker')?.value).toBe('still-here');
  });

  it('control: an unedited entity still reads its base properties through bim.properties()', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const walls = bim.query().byType('IfcWall').toArray();
    // The destructuring below needs a victim AND a distinct control.
    expect(walls.length).toBeGreaterThanOrEqual(2);

    // Mutate a DIFFERENT wall so a mutation view exists this session, then
    // confirm an untouched wall's properties are unaffected (still routed
    // correctly through the overlay's base-merge, not just returning empty).
    // The baseline is read BEFORE the mutation — two post-mutation reads of
    // the same entity are equal by construction and could not catch the
    // overlay corrupting the control entity.
    const [victim, control] = walls;
    const before = bim.properties(control.ref);
    expect(before.length).toBeGreaterThan(0);

    bim.mutate.setProperty(victim.ref, 'Pset_RoundTripAudit', 'AuditMarker', 'edited-value');

    const after = bim.properties(control.ref);
    expect(after).toEqual(before);
    // And the control never grew the victim's mutated pset.
    expect(after.find((ps) => ps.name === 'Pset_RoundTripAudit')).toBeUndefined();
  });
});
