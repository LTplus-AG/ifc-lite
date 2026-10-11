/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IDS-033: a refused edit's remedies are new batches that pass the gate, not bypasses of it. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkOps } from '@ifc-lite/ids-authoring';
import { wallFixture } from '@/test/ids-studio-fixture';
import { setFieldOp } from './ops';
import { withCandidate, withCustomDeclaration } from './rejection';

describe('gate rejection remedies', () => {
  it('substitutes a ranked candidate where the issue points, and the gate then accepts the batch', async () => {
    const { contexts, doc, propertyId } = await wallFixture();
    const ops = [setFieldOp(propertyId, 'property.baseName', { kind: 'equals', value: 'FireRatng' })];
    const refused = checkOps(ops, doc, contexts.gate);
    assert.equal(refused.ok, false);
    const issue = refused.issues[0];
    const fixed = withCandidate(ops, issue, issue.candidates[0].value);
    assert.ok(fixed);
    assert.notEqual(fixed[0].opId, ops[0].opId, 'a resubmission is a new batch');
    assert.equal(checkOps(fixed, doc, contexts.gate).ok, true);
  });

  it('declares an undeclared custom property set only on request, then the same batch passes', async () => {
    const { contexts, doc, propertyId } = await wallFixture();
    const ops = [setFieldOp(propertyId, 'property.propertySet', { kind: 'equals', value: 'Acme_FireSafety' })];
    const refused = checkOps(ops, doc, contexts.gate);
    const issue = refused.issues.find((i) => i.code === 'GATE-CUST-001');
    assert.ok(issue, 'the gate refuses an undeclared custom set');
    const declared = withCustomDeclaration(ops, issue);
    assert.ok(declared);
    assert.equal(declared[0].kind, 'meta.custom.declarePset');
    assert.equal(checkOps(declared, doc, contexts.gate).ok, true);
    assert.equal(withCustomDeclaration(ops, { ...issue, code: 'GATE-PROP-001' }), null, 'only for GATE-CUST-001');
  });

  it('declines to substitute when the issue does not point at a literal', async () => {
    const { propertyId } = await wallFixture();
    const ops = [setFieldOp(propertyId, 'property.value', { kind: 'oneOf', values: ['a'] })];
    assert.equal(withCandidate(ops, { ok: false, code: 'GATE-VAL-001', path: 'ops[0].payload.value', message: '', candidates: [], opIndex: 0 }, 'x'), null);
    assert.equal(withCandidate(ops, { ok: false, code: 'GATE-VAL-001', path: 'nonsense', message: '', candidates: [], opIndex: 0 }, 'x'), null);
  });
});
