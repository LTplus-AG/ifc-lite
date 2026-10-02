/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { newSavedReport } from '../reports/history.js';
import * as manualModels from './manual-model.js';
// The canonical pre-feature module still loads in the production-revert oracle.
// Missing recovery must fail the real projection/refusal assertions below.
const manualReportReuse = (...args: Parameters<typeof manualModels.manualReportReuse>) => manualModels.manualReportReuse?.(...args);
import { pickManualModel } from './manual-model.js';
import { saveManualLibrary, loadManualLibrary } from './persistence.js';
import type { ChecklistTemplate } from './checklist.js';

const models = [{ id: 'new-uuid', name: 'Source.ifc', fingerprint: 'source-fingerprint' },
  { id: 'active-peer', name: 'Source.ifc', fingerprint: 'different-fingerprint' }];
function recorded(template: ChecklistTemplate = { version: 1, name: 'Recorded review', groups: [
  { id: 'g', name: 'Delivery', items: [{ id: '__proto__', text: 'Uploaded on time', description: 'Recorded guidance' },
    { id: 'note', text: 'Pending clarification' }] },
] }) {
  return newSavedReport(manualReportBlockFromChecklist({ checklist: template,
    modelFingerprint: 'source-fingerprint', modelName: 'Source.ifc', now: new Date('2026-09-20T10:30:00Z'),
    answers: Object.fromEntries(template.groups.flatMap(group => group.items.map(item => [item.id,
      { status: item.id === 'note' ? null : 'warning', comment: 'Recorded comment', updatedAt: 1 }]))),
  }, 'snapshot'));
}

describe('Saved report recovery invariants (#6611)', () => {
  it('keeps complete recorded content and prototype-shaped IDs through canonical persistence', () => {
    localStorage.clear();
    const report = recorded();
    const original = JSON.stringify(report);
    const recovered = manualReportReuse(report.snapshot, models);
    assert.ok(recovered?.ok);
    assert.equal(recovered.template.groups[0].items[0].description, 'Recorded guidance');
    assert.equal(recovered.answers['source-fingerprint']['__proto__'].status, 'warning');
    assert.equal(recovered.answers['source-fingerprint'].note.status, null);
    assert.equal(recovered.answers['source-fingerprint'].note.comment, 'Recorded comment');
    assert.equal(recovered.answers['source-fingerprint'].note.updatedAt, Date.parse(report.snapshot.generatedAt), 'only recording time is available in the snapshot');
    assert.equal(Object.getPrototypeOf(recovered.answers['source-fingerprint']), Object.prototype);
    assert.ok(saveManualLibrary({ version: 1, activeId: 'copy', checklists: [{ id: 'copy', template: recovered.template, answers: recovered.answers, preferredModelFingerprint: recovered.preferredModelFingerprint }] }).ok);
    const reopened = loadManualLibrary().library.checklists[0];
    assert.equal(reopened.preferredModelFingerprint, 'source-fingerprint');
    assert.deepEqual(reopened.template, recovered.template);
    assert.deepEqual(reopened.answers, recovered.answers);
    assert.equal(JSON.stringify(report), original);
  });

  it('requires the actual recorded fingerprint instead of an identically named active peer', () => {
    assert.deepEqual(manualReportReuse(recorded().snapshot, [models[1]]), { ok: false, reason: 'modelNotLoaded' });
    const report = recorded();
    if (report.snapshot.kind !== 'manual-report') assert.fail('canonical manual snapshot');
    delete report.snapshot.modelFingerprint;
    assert.deepEqual(manualReportReuse(report.snapshot, models), { ok: false, reason: 'noIdentity' });
  });

  it('refuses imported text, answer-count and date violations instead of truncating old evidence', () => {
    const long = recorded();
    if (long.snapshot.kind !== 'manual-report') assert.fail('canonical manual snapshot');
    long.snapshot.groups[0].items[0].comment = 'x'.repeat(2001);
    assert.deepEqual(manualReportReuse(long.snapshot, models), { ok: false, reason: 'invalid' });
    const invalidDate = recorded(); invalidDate.snapshot.generatedAt = 'not a date';
    assert.deepEqual(manualReportReuse(invalidDate.snapshot, models), { ok: false, reason: 'invalid' });
    const oversized = recorded({ version: 1, name: 'Large imported report', groups: Array.from({ length: 41 }, (_, g) => ({
      id: `group-${g}`, name: 'Group', items: Array.from({ length: 500 }, (_, i) => ({ id: `check-${g}-${i}`, text: 'Check' })),
    })) });
    assert.deepEqual(manualReportReuse(oversized.snapshot, models), { ok: false, reason: 'invalid' });
  });

  it('uses explicit selection first and refuses automatic peer fallback after source removal', () => {
    assert.equal(pickManualModel(models, null, 'active-peer', 'source-fingerprint')?.id, 'new-uuid');
    assert.equal(pickManualModel([models[1]], null, 'active-peer', 'source-fingerprint'), null);
    assert.equal(pickManualModel(models, 'active-peer', null, 'source-fingerprint')?.id, 'active-peer');
    assert.equal(pickManualModel(models, null, 'active-peer')?.id, 'active-peer', 'legacy unbound checklists keep their existing rule');
  });
});
