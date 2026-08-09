/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The comparison's oracle test: a two-revision infrastructure model whose
 * added / deleted / modified GlobalId sets are known, asserted through the real
 * `@ifc-lite/diff` engine driven the way the viewer drives it
 * (`matchUnpairedByContent: true`).
 *
 * The shapes and the expected answer come from an externally corroborated
 * comparison of a real infrastructure certification sample pair, reproduced
 * here synthetically (see {@link infraRevisionModel}) because the models
 * themselves are not in the repo. What that pair established, and what this
 * pins:
 *
 * - **A cleared `PredefinedType` is a modification.** It was the *only* edit on
 *   19 of that pair's 23 modified products, so a comparison that cannot see it
 *   under-reports by a factor of four while looking perfectly healthy.
 * - **On an IFC4X3-only class it was invisible.** `IfcCourse`, `IfcPavement`,
 *   `IfcKerb`, `IfcSignal` and the rest of the IFC4.3 infrastructure vocabulary
 *   are outside the parser's IFC4 codegen pin, and the fingerprint adapters read
 *   `PredefinedType` by name through that pin — which answers an *empty
 *   attribute list*, not a wrong one, so both revisions hashed the element with
 *   no `PredefinedType` at all and it compared equal to itself. Same family as
 *   the `Tag` defect #2021 fixed one line below, on the classes IFC4X3 exists
 *   for.
 * - **Nothing else may move.** An untouched IFC4X3 element must still read
 *   `unchanged`: a fingerprint that sees more must not start reporting
 *   everything as modified.
 */

import { describe, expect, it } from 'vitest';
import { diffModels, type DiffState } from '@ifc-lite/diff';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { buildFileFingerprints } from './diff-engine.js';
import { guid, infraRevisionModel } from './diff-test-helpers.js';

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
}

/** Every key the diff put in one state, sorted so the assertion is on a set. */
function keysIn(entries: { key: string; state: DiffState }[], state: DiffState): string[] {
  return entries
    .filter((entry) => entry.state === state)
    .map((entry) => entry.key)
    .sort();
}

describe('diff --by-content — the infrastructure revision oracle', () => {
  async function runDiff() {
    const base = await parse(infraRevisionModel(1));
    const head = await parse(infraRevisionModel(2));
    return diffModels(buildFileFingerprints(base), buildFileFingerprints(head), {
      scope: 'data',
      // The viewer's default (`compareMatchByContent`), so this test measures
      // the configuration users actually get.
      matchUnpairedByContent: true,
    });
  }

  it('reports exactly the added, deleted and modified GlobalIds', async () => {
    const diff = await runDiff();

    expect(keysIn(diff.entries, 'added')).toEqual([guid('SIGN')]);
    expect(keysIn(diff.entries, 'deleted')).toEqual([guid('KERB')]);
    expect(keysIn(diff.entries, 'modified')).toEqual([guid('COUR'), guid('PROX')].sort());
    // The project and the untouched IFC4X3 element, and nothing else.
    expect(keysIn(diff.entries, 'unchanged')).toEqual([guid('PAVE'), guid('PROJ')].sort());
  });

  it('sees a cleared PredefinedType on an IFC4X3-only class', async () => {
    const diff = await runDiff();
    const course = diff.byKey.get(guid('COUR'));

    expect(course?.state).toBe('modified');
    // The whole edit is one direct attribute, so the evidence has to be
    // `attr:core` — a `modified` carried by a pset or a type assignment would
    // mean the fixture, not the attribute, moved.
    expect(course?.changedComponents).toEqual(['attr:core']);
  });

  it('leaves an untouched IFC4X3 element unchanged', async () => {
    const diff = await runDiff();
    const pavement = diff.byKey.get(guid('PAVE'));

    expect(pavement?.state).toBe('unchanged');
    expect(pavement?.changedComponents ?? []).toEqual([]);
  });

  it('sees a reclassified element that kept its GlobalId', async () => {
    const diff = await runDiff();
    const proxy = diff.byKey.get(guid('PROX'));

    expect(proxy?.state).toBe('modified');
    expect(proxy?.base?.ifcType).toBe('IfcBuildingElementProxy');
    expect(proxy?.head?.ifcType).toBe('IfcGeographicElement');
  });
});
