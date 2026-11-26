/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, mock, test } from 'node:test';
import { parseIDS } from '@ifc-lite/ids';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { clashReviewKey, type Clash, type ClashResult } from '@ifc-lite/clash';
import { buildInitialPresets, DEFAULT_CLASH_SETTINGS, loadExclusions, loadReviews, loadSettings,
  saveExclusions, savePresets, saveReviews, saveSettings,
} from '../clash/persistence.js';
import { loadRevisionBaseline, saveRevisionBaseline } from '../clash/revision-baseline.js';
import { loadDefinitionLibrary, saveDefinitionLibrary } from '../validation/definition-library.js';
import { loadManualLibrary, saveManualLibrary } from '../validation/manual/persistence.js';
import { CHECKLIST_VERSION, type ChecklistTemplate } from '../validation/manual/checklist.js';
import { createContentBackup, encodeContentBackup, importContentBackup, parseContentBackup, readBackupDrafts, readContentRecovery } from './content-backup.js';
import { contentTransaction, transactionDone } from './content-database.js';

const empty = () => ({ validation: [], comparison: [], document: [] });
const wire = () => JSON.stringify(encodeContentBackup(createContentBackup(empty())));
const reviewKey = 'ifc-lite-clash-reviews';
const presetsKey = 'ifc-lite-clash-presets';
const manualKey = 'ifc-lite:validation:manual-library';
const settingsKey = 'ifc-lite-clash-settings';
const exclusionsKey = 'ifc-lite-clash-exclusions';
const template: ChecklistTemplate = { version: CHECKLIST_VERSION, name: 'Survey', groups: [{ id: 'survey', name: 'Coordinates', items: [{ id: 'origin', text: 'Origin agrees with survey' }] }] };
const answers = { 'source-hash': { origin: { status: 'fail' as const, updatedAt: 12, comment: 'Survey differs' } } };

beforeEach(async () => {
  localStorage.clear();
  const tx = await contentTransaction(['items', 'recovery'], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore('items').clear();
  tx.objectStore('recovery').clear();
  await done;
});

test('#10976 library backup restores saved clash configuration, triage, baseline, and live validation libraries after clearing browser data', async () => {
  const custom = { id: 'custom-pipe', name: 'Pipe clearance', description: 'Coordination', selectorA: 'IfcPipeSegment', selectorB: 'IfcWall', severity: 'major' as const, enabled: true, builtin: false };
  const [first, ...other] = buildInitialPresets();
  assert.ok(first);
  assert.ok(savePresets([{ ...first, enabled: false }, ...other, custom]).ok);
  const settings = { ...DEFAULT_CLASH_SETTINGS, mode: 'clearance' as const, clearance: 0.15 };
  assert.ok(saveSettings({ ...settings, groupBy: 'typePair' }).ok);
  const exclusion = { id: 'designed', kind: 'typeAny' as const, a: 'IfcFastener', b: 'IfcFastener', label: 'Designed contact', enabled: true, createdAt: 9 };
  assert.ok(saveExclusions([exclusion]).ok);
  const clash: Clash = {
    id: 'run-pair', a: { key: 'wall-guid', ref: 1, model: 'arch', tag: 'IfcWall' },
    b: { key: 'pipe-guid', ref: 2, model: 'mep', tag: 'IfcPipeSegment' }, rule: custom.id, status: 'hard',
    distance: -0.01, point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
  };
  const review = { status: 'accepted' as const, comment: 'Sleeve agreed', updatedAt: 3 };
  assert.ok(saveReviews(new Map([[clashReviewKey(clash), review]])).ok);
  const result: ClashResult = {
    clashes: [clash], summary: { total: 1, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: 1, minor: 0, info: 0 } },
    rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
  const baseline = { result, takenAt: 123, modelNames: { arch: 'arch.ifc', mep: 'mep.ifc' } };
  assert.ok(saveRevisionBaseline(baseline).ok);
  const rules = parseRuleSetFile({ version: 1, name: 'Information checks', rules: [] });
  assert.ok(rules.ok);
  const xml = readFileSync(new URL('../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');
  const definitions = {
    version: 1 as const, active: { rules: 'rules-a', ids: 'ids-a' },
    entries: [{ id: 'rules-a', kind: 'rules' as const, file: rules.file }, { id: 'ids-a', kind: 'ids' as const, xml, document: parseIDS(xml) }],
  };
  assert.equal(saveDefinitionLibrary(definitions, true), null);
  const manual = { version: 1 as const, activeId: 'survey', checklists: [{ id: 'survey', template, answers, preferredModelFingerprint: 'source-hash' }] };
  assert.ok(saveManualLibrary(manual).ok);

  const file = parseContentBackup(wire());
  assert.equal(file.version, 3);
  localStorage.clear();
  assert.equal(await importContentBackup(file), 7);
  assert.deepEqual(buildInitialPresets().find(row => row.id === custom.id), custom);
  assert.equal(buildInitialPresets().find(row => row.id === first.id)?.enabled, false);
  assert.deepEqual(loadSettings(), settings);
  assert.deepEqual(loadExclusions(), [exclusion]);
  assert.deepEqual(loadReviews().get(clashReviewKey({ ...clash, a: { ...clash.a, model: 'new-arch' } })), review);
  assert.deepEqual(loadRevisionBaseline(), baseline);
  assert.deepEqual(loadDefinitionLibrary().library, definitions);
  assert.deepEqual(loadManualLibrary().library, manual);
  assert.equal(await importContentBackup(file), 0, 'reimport is a no-op');
});

test('#10976 preserves conflicting and unreadable originals while restoring nonconflicting review decisions', async () => {
  const incoming = { status: 'resolved' as const, comment: 'Incoming resolution' };
  assert.ok(saveReviews(new Map([['shared', incoming], ['new', incoming]])).ok);
  assert.ok(saveExclusions([{ id: 'new', kind: 'typeAny', a: 'IfcWall', b: 'IfcWall', enabled: true, label: 'By design', createdAt: 1 }]).ok);
  const sourceOriginal = '{"presets":[42]}';
  localStorage.setItem(presetsKey, sourceOriginal);
  localStorage.setItem(`${presetsKey}:unreadable:2`, 'earlier corrupt rule');
  const file = parseContentBackup(wire());

  localStorage.clear();
  assert.ok(saveReviews(new Map([['shared', { status: 'accepted', comment: 'Local decision' }]])).ok);
  const targetOriginal = '{unreadable exclusions';
  localStorage.setItem(exclusionsKey, targetOriginal);
  assert.equal(await importContentBackup(file), 1);
  assert.equal(loadReviews().get('shared')?.comment, 'Local decision');
  assert.deepEqual(loadReviews().get('new'), incoming);
  assert.equal(localStorage.getItem(exclusionsKey), targetOriginal);
  await importContentBackup(file);
  const { drafts } = await readBackupDrafts();
  assert.deepEqual(drafts.map(entry => entry.id).sort(), [exclusionsKey, presetsKey, `${presetsKey}:unreadable:2`, reviewKey].sort());
  assert.equal(JSON.parse(drafts.find(entry => entry.id === presetsKey)!.raw).original, sourceOriginal);
  assert.equal(parseContentBackup(JSON.stringify(encodeContentBackup(createContentBackup(empty(), {}, drafts)))).version, 3);
});

test('#10976 reads and migrates legacy manual answers without mutating the source at download', async () => {
  const legacyKey = 'ifc-lite:validation:manual-answers';
  localStorage.setItem('ifc-lite:validation:manual-checklist', JSON.stringify(template));
  localStorage.setItem(legacyKey, JSON.stringify({ schemaVersion: 1, models: answers }));
  const file = parseContentBackup(wire());
  assert.ok(localStorage.getItem(legacyKey));
  assert.equal(localStorage.getItem(manualKey), null);
  localStorage.clear();
  assert.equal(await importContentBackup(file), 1);
  assert.deepEqual(loadManualLibrary().library.checklists[0].answers, answers);
});

test('#10976 v1 and v2 remain readable and credential keys and UI preferences stay out of backups', async () => {
  for (const [index, key] of ['ifc-lite:api-keys:v1', 'ifc-lite:bcf-server:v1', 'ifc-lite:collab:identity',
    'ifc-lite-source:provider:oauth-token', 'ifc-lite:cloud:vendor:callback', 'ifc-lite.influx.experimental.v1'].entries()) {
    localStorage.setItem(key, `excluded-value-${index}`);
    localStorage.setItem(`${key}:unreadable`, `excluded-original-${index}`);
  }
  assert.ok(saveSettings({ ...DEFAULT_CLASH_SETTINGS, groupBy: 'typePair' }).ok);
  const exported = wire();
  assert.doesNotMatch(exported, /excluded-(?:value|original)|typePair/);
  assert.equal(JSON.parse(exported).version, 1);
  for (const version of [1, 2]) {
    const legacy = parseContentBackup(JSON.stringify({ version, exportedAt: '2026-01-01', libraries: { ...empty(), ...(version === 2 ? { filters: [] } : {}) } }));
    assert.equal(await importContentBackup(legacy), 0);
    assert.equal(loadSettings().groupBy, 'typePair');
  }
  const illegal = JSON.stringify({ version: 3, libraries: { ...empty(), localWork: { 'ifc-lite:api-keys:v1': '{}' } } });
  assert.throws(() => parseContentBackup(illegal), /Invalid local work backup entry/);
});

test('#10976 import refuses a late write and can be reimported without overwriting the newly saved settings', async () => {
  assert.ok(saveSettings({ ...DEFAULT_CLASH_SETTINGS, clearance: 0.15 }).ok);
  const file = parseContentBackup(wire());
  localStorage.clear();
  const change = mock.fn(() => localStorage.setItem(settingsKey, JSON.stringify({ ...DEFAULT_CLASH_SETTINGS, clearance: 0.25 })));
  await assert.rejects(importContentBackup(file, undefined, true, change), /could not be restored/i);
  assert.equal(loadSettings().clearance, 0.25);
  assert.equal(await importContentBackup(file), 0);
  assert.equal(loadSettings().clearance, 0.25);
  assert.ok((await readBackupDrafts()).drafts.some(draft => draft.id === settingsKey));
});

test('#10976 restores the active checklist beside pending legacy answers without a checklist', async () => {
  const checklist = { id: 'imported', template, answers };
  assert.ok(saveManualLibrary({ version: 1, activeId: 'imported', checklists: [checklist] }).ok);
  const file = parseContentBackup(wire());
  const pending = { older: { origin: { status: 'warning' as const, updatedAt: 9 } } };
  assert.ok(saveManualLibrary({ version: 1, activeId: null, checklists: [], pendingLegacyAnswers: pending }).ok);
  assert.equal(await importContentBackup(file), 1);
  assert.deepEqual(loadManualLibrary().library,
    { version: 1, activeId: 'imported', checklists: [checklist], pendingLegacyAnswers: pending });
});

test('#10976 preserved-originals download reports an incomplete browser read', async () => {
  const read = localStorage.getItem.bind(localStorage);
  const refused = mock.method(localStorage, 'getItem', (key: string) => {
    if (key === reviewKey) throw new DOMException('Review storage blocked', 'SecurityError');
    return read(key);
  });
  try {
    await assert.rejects(readContentRecovery(), /Could not fully read browser storage for preserved originals/);
    localStorage.setItem(presetsKey, '{invalid rules');
    const incomplete = mock.fn();
    const rows = await readContentRecovery(incomplete);
    assert.equal(incomplete.mock.callCount(), 1);
    assert.ok(rows.some(row => JSON.parse(JSON.parse(row.raw).raw).original === '{invalid rules'));
  } finally { refused.mock.restore(); }
});
