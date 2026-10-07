/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { facilitatorScript, loadStudy } from '../study.mjs';
import { protocolErrors, sessionErrors, summarize } from './study.mjs';
import { REPO_ROOT } from './recording.mjs';

const { protocol, schema, manifest } = loadStudy(REPO_ROOT);
const clone = value => structuredClone(value);
let counter = 0;
const session = (participant, role, task, variant, extra = {}) => ({ version: 1, id: `s-${++counter}`, participant, role, variant, task, completed: true, seconds: 60,
  discovery: 'unaided', backtracks: 0, panelSwitches: 1, scopeErrors: 0, wrongTargetEffects: 0, accidentalEffects: 0, ...extra });

/** `perRole` participants per role, every task both variants; `change(session)` may degrade individual sessions. */
function cohort(perRole, change = () => {}) {
  const sessions = [];
  let next = 1;
  for (const role of protocol.roles) for (let i = 0; i < perRole; i++) {
    const participant = `p${String(next++).padStart(2, '0')}`;
    for (const task of protocol.tasks.filter(item => item.roles.includes(role.id))) for (const variant of ['current', 'assisted']) {
      const row = session(participant, role.id, task.id, variant);
      change(row);
      sessions.push(row);
    }
  }
  return sessions;
}

test('the committed protocol is valid, ties tasks to manifest journeys and scenes, and records no sessions yet', () => {
  assert.deepEqual(protocolErrors(protocol, { root: REPO_ROOT, manifest }), []);
  assert.equal(protocol.status, 'proposed');
  assert.equal(loadStudy(REPO_ROOT).sessions.length, 0, 'no fabricated sessions are committed');
});

test('protocol errors: unknown scene, role, panel and a role nobody is assigned to', () => {
  const broken = clone(protocol);
  broken.tasks[0].scene = 'nowhere';
  broken.tasks[0].roles.push('wizard');
  broken.tasks[1].entry.current.panels.push('not-a-panel');
  broken.roles.push({ id: 'ghost', description: 'unused' });
  const errors = protocolErrors(broken, { root: REPO_ROOT, manifest, panelIds: ['validation', 'properties', 'clash', 'bcf', 'flow', 'assistant'] });
  for (const part of [/unknown scene nowhere/, /unknown role wizard/, /unknown panel not-a-panel/, /role ghost: no task/]) assert.ok(errors.some(error => part.test(error)), `${part} in ${errors}`);
});

test('session errors: wrong role for a task, contradictions, duplicate ids, a time far over the cap, and identifying text', () => {
  const task = protocol.tasks.find(item => !item.roles.includes('occasional'));
  const bad = [
    { name: 'a', session: session('p01', 'occasional', task.id, 'current') },
    { name: 'b', session: session('p02', 'coordinator', task.id, 'current', { discovery: 'failed' }) },
    { name: 'c', session: session('p03', 'coordinator', task.id, 'current', { scopeErrors: 0, wrongTargetEffects: 1 }) },
    { name: 'd', session: session('p04', 'coordinator', task.id, 'current', { seconds: task.capSeconds * 2 }) },
    { name: 'e', session: session('p05', 'coordinator', task.id, 'current', { notes: 'mail me at jo@example.com' }) },
  ];
  bad.push({ name: 'f', session: { ...bad[1].session } });
  const errors = sessionErrors(bad, protocol, schema).join('\n');
  for (const part of [/not assigned to task/, /failed discovery is contradictory/, /wrongTargetEffects cannot exceed/, /far above the .* cap/, /privacy scan/, /duplicate id/]) assert.match(errors, part);
});

test('no threshold is judged until every role has the minimum participants', () => {
  const result = summarize(protocol, cohort(protocol.minimumParticipantsPerRole - 1));
  assert.equal(result.verdict, 'insufficient-data');
  assert.match(result.reason, /fewer than 3 participants/);
  assert.equal(summarize(protocol, []).verdict, 'insufficient-data');
});

test('a clean cohort meets the proposed thresholds but is flagged as only proposed', () => {
  const result = summarize(protocol, cohort(3));
  assert.equal(result.verdict, 'met');
  assert.match(result.caveat, /still proposed/);
  assert.equal(result.perTask[0].variants.assisted.completionRate, 1);
});

test('low unaided completion, assisted below current, and any wrong-target effect each fail the verdict', () => {
  const hinted = summarize(protocol, cohort(3, row => { if (row.variant === 'assisted' && row.task === 'find-check') row.discovery = 'hinted'; }));
  assert.equal(hinted.verdict, 'not-met');
  assert.ok(hinted.failures.some(failure => /find-check: unaided completion 0\.00/.test(failure)));

  const worse = summarize(protocol, cohort(3, row => { if (row.variant === 'assisted' && row.task === 'author-flow') { row.completed = false; row.discovery = 'unaided'; } }));
  assert.ok(worse.failures.some(failure => /author-flow: assisted completion .* below the current/.test(failure)));

  let first = true;
  const wrong = summarize(protocol, cohort(3, row => { if (first) { first = false; row.scopeErrors = 1; row.wrongTargetEffects = 1; } }));
  assert.ok(wrong.failures.some(failure => /1 wrong-target effect\(s\)/.test(failure)));
});

test('the facilitator script carries every task prompt and cap verbatim', () => {
  const script = facilitatorScript(protocol);
  for (const task of protocol.tasks) assert.ok(script.includes(task.participantPrompt) && script.includes(`cap ${task.capSeconds}s`));
});

test('summaries use the median time and sum the error counts', () => {
  const rows = [10, 20, 90].map((seconds, index) => session(`p0${index + 1}`, 'coordinator', 'find-check', 'current', { seconds, scopeErrors: index }));
  const cell = summarize(protocol, rows).perTask[0].variants.current;
  assert.equal(cell.medianSeconds, 20);
  assert.equal(cell.scopeErrors, 3);
});

test('every task x variant cell needs enough participants of each of its roles before any threshold is judged', () => {
  // Three of each role, but every session is find-check in the current viewer: role counts pass, cells do not.
  const sessions = protocol.roles.flatMap(role => [1, 2, 3].map(i => session(`${role.id}-${i}`, role.id, 'find-check', 'current')));
  const result = summarize(protocol, sessions);
  assert.equal(result.verdict, 'insufficient-data');
  assert.match(result.reason, /find-check\/assisted\/coordinator \(0\)/);
  const dropped = cohort(3).filter(row => !(row.task === 'draft-bcf' && row.variant === 'assisted' && row.participant === 'p01'));
  assert.equal(summarize(protocol, dropped).verdict, 'insufficient-data', 'one missing assisted session leaves that cell short');
  assert.equal(summarize(protocol, cohort(3)).verdict, 'met');
});
