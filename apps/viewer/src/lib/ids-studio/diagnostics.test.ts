/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-036: diagnostics land on the outline row of their node, a quick fix is
 * previewed on a copy (the document is untouched), and applying it through the
 * gate removes the finding.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commit, createLinter } from '@ifc-lite/ids-authoring';
import { wallFixture } from '@/test/ids-studio-fixture';
import { indexDiagnostics, previewFix, rowIdOf, sortDiagnostics } from './diagnostics';
import { dispatchStudioOps } from './session';
import { setFieldOp } from './ops';

describe('Studio diagnostics (IDS-036)', () => {
  it('maps a constraint-level finding to its facet row and rolls the severity up to the spec', async () => {
    const { contexts, state, specId, propertyId } = await wallFixture();
    // A comparison typed into a simple value: IDSL-VAL-004.
    const edited = commit(state, [setFieldOp(propertyId, 'property.value', { kind: 'equals', value: '>= 60' })]).state.doc;
    const { diagnostics } = createLinter(contexts.lint).lint(edited);
    const finding = diagnostics.find((d) => d.code === 'IDSL-VAL-004');
    assert.ok(finding, diagnostics.map((d) => d.code).join(', '));
    assert.equal(rowIdOf(edited, finding.nodeId), propertyId);
    const index = indexDiagnostics(edited, diagnostics);
    assert.ok(index.byRow.get(propertyId)?.includes(finding));
    assert.equal(index.severity.get(specId), 'warning');
    assert.equal(index.counts.warning >= 1, true);
  });

  it('previews a quick fix as before/after sentences without touching the document, then applies it through the gate', async () => {
    const { contexts, state, propertyId } = await wallFixture();
    const edited = commit(state, [setFieldOp(propertyId, 'property.value', { kind: 'equals', value: ' EI60' })]).state;
    const linter = createLinter(contexts.lint);
    const finding = linter.lint(edited.doc).diagnostics.find((d) => d.code === 'IDSL-VAL-006');
    const fix = finding?.fixes?.[0];
    assert.ok(fix, 'the whitespace rule offers a fix');
    const before = structuredClone(edited.doc);
    const preview = previewFix(edited.doc, fix);
    assert.deepEqual(edited.doc, before, 'previewing never mutates the document');
    assert.ok(preview.ok);
    assert.equal(preview.changes.length, 1);
    assert.equal(preview.changes[0].nodeId, propertyId);
    assert.notEqual(preview.changes[0].before, preview.changes[0].after);

    const applied = dispatchStudioOps(edited, fix.ops, contexts.gate, { label: fix.label });
    assert.equal(applied.ok, true);
    assert.ok(!linter.lint(applied.state.doc).diagnostics.some((d) => d.code === 'IDSL-VAL-006'), 'the finding is gone');
  });

  it('lists errors before warnings before infos', () => {
    const d = (severity: 'error' | 'warning' | 'info', code: string) => ({ code, severity, nodeId: code, message: '', docsUrl: '' });
    assert.deepEqual(sortDiagnostics([d('info', 'a'), d('error', 'b'), d('warning', 'c'), d('error', 'd')]).map((x) => x.code), ['b', 'd', 'c', 'a']);
  });
});
