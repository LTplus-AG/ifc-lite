/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * U01 coordinator study tooling (#6928): protocol and session-record checks,
 * and the summary that compares recorded sessions with the protocol's
 * thresholds. The summary refuses to call a threshold met or missed until
 * every role has the protocol's minimum number of participants, and it states
 * whether the thresholds are still only proposed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from './schema-subset.mjs';
import { privacyFindings } from './manifest.mjs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

const unique = (list, at, errors) => {
  const seen = new Set();
  for (const id of list) { if (seen.has(id)) errors.push(`${at}: duplicate id ${id}`); seen.add(id); }
};

/**
 * Protocol errors; `manifest` is the evaluation manifest (journeys and scenes
 * must exist) and `panelIds` the viewer registry's panel ids (null skips that
 * check; the viewer's own test supplies the real ones).
 */
export function protocolErrors(protocol, { root, manifest, panelIds = null }) {
  const errors = validateSchema(readJson(join(root, 'tests', 'ai-eval', 'study', 'protocol.schema.json')), protocol);
  if (errors.length) return errors;
  unique(protocol.tasks.map(task => task.id), 'tasks', errors);
  unique(protocol.roles.map(role => role.id), 'roles', errors);
  const roles = new Set(protocol.roles.map(role => role.id));
  const journeys = new Set(manifest.journeys.map(journey => journey.id));
  const scenes = new Set(manifest.scenes.map(scene => scene.id));
  for (const variant of ['current', 'assisted']) if (!protocol.variants.some(item => item.id === variant)) errors.push(`variants: missing ${variant}`);
  for (const task of protocol.tasks) {
    const at = `task ${task.id}`;
    if (!journeys.has(task.journey)) errors.push(`${at}: unknown journey ${task.journey}`);
    if (!scenes.has(task.scene)) errors.push(`${at}: unknown scene ${task.scene}`);
    for (const role of task.roles) if (!roles.has(role)) errors.push(`${at}: unknown role ${role}`);
    if (panelIds) for (const variant of Object.keys(task.entry)) for (const panel of task.entry[variant].panels) {
      if (!panelIds.includes(panel)) errors.push(`${at}: ${variant} entry names unknown panel ${panel}`);
    }
  }
  for (const role of protocol.roles) if (!protocol.tasks.some(task => task.roles.includes(role.id))) errors.push(`role ${role.id}: no task is assigned to it`);
  return errors;
}

/** Session-record errors against the protocol; `sessions` is `[{ name, session }]`. */
export function sessionErrors(sessions, protocol, schema) {
  const errors = [];
  unique(sessions.map(({ session }) => session.id), 'sessions', errors);
  const tasks = new Map(protocol.tasks.map(task => [task.id, task]));
  const variants = new Set(protocol.variants.map(variant => variant.id));
  const roleOf = new Map();
  for (const { name, session } of sessions) {
    for (const error of validateSchema(schema, session)) errors.push(`session ${name}: ${error}`);
    const task = tasks.get(session.task);
    if (!task) errors.push(`session ${name}: unknown task ${session.task}`);
    else if (!task.roles.includes(session.role)) errors.push(`session ${name}: role ${session.role} is not assigned to task ${task.id}`);
    if (!variants.has(session.variant)) errors.push(`session ${name}: unknown variant ${session.variant}`);
    if (roleOf.has(session.participant) && roleOf.get(session.participant) !== session.role) errors.push(`session ${name}: participant ${session.participant} appears with two roles`);
    roleOf.set(session.participant, session.role);
    if (task && session.seconds > task.capSeconds * 1.5) errors.push(`session ${name}: ${session.seconds}s is far above the ${task.capSeconds}s cap; was the task stopped at the cap?`);
    if (session.completed && session.discovery === 'failed') errors.push(`session ${name}: completed with failed discovery is contradictory`);
    if (session.wrongTargetEffects > session.scopeErrors) errors.push(`session ${name}: wrongTargetEffects cannot exceed scopeErrors`);
    const findings = privacyFindings(JSON.stringify(session), 'json');
    if (findings.length) errors.push(`session ${name}: privacy scan: ${findings.join('; ')}`);
  }
  return errors;
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);

/** Per task x variant measures and the threshold status. Sessions must already be valid. */
export function summarize(protocol, sessions) {
  const perTask = protocol.tasks.map(task => ({ task: task.id, variants: Object.fromEntries(protocol.variants.map(variant => {
    const rows = sessions.filter(session => session.task === task.id && session.variant === variant.id);
    const completed = rows.filter(row => row.completed);
    return [variant.id, { n: rows.length, completionRate: rows.length ? completed.length / rows.length : null,
      unaidedCompletionRate: rows.length ? completed.filter(row => row.discovery === 'unaided').length / rows.length : null,
      medianSeconds: median(rows.map(row => row.seconds)), backtracks: sum(rows, 'backtracks'), panelSwitches: sum(rows, 'panelSwitches'),
      scopeErrors: sum(rows, 'scopeErrors'), wrongTargetEffects: sum(rows, 'wrongTargetEffects'), accidentalEffects: sum(rows, 'accidentalEffects') }];
  })) }));
  const participants = Object.fromEntries(protocol.roles.map(role =>
    [role.id, new Set(sessions.filter(session => session.role === role.id).map(session => session.participant)).size]));
  const short = protocol.roles.filter(role => participants[role.id] < protocol.minimumParticipantsPerRole).map(role => role.id);
  const base = { thresholdsStatus: protocol.status, participants, minimumParticipantsPerRole: protocol.minimumParticipantsPerRole, perTask };
  if (short.length) return { ...base, verdict: 'insufficient-data', reason: `fewer than ${protocol.minimumParticipantsPerRole} participants for: ${short.join(', ')}; no threshold is judged` };
  const failures = [];
  for (const row of perTask) {
    const { current, assisted } = row.variants;
    if (assisted.unaidedCompletionRate !== null && assisted.unaidedCompletionRate < protocol.thresholds.unaidedCompletionRate) {
      failures.push(`${row.task}: unaided completion ${assisted.unaidedCompletionRate.toFixed(2)} is below ${protocol.thresholds.unaidedCompletionRate}`);
    }
    if (protocol.thresholds.assistedCompletionNotBelowCurrent && current.completionRate !== null && assisted.completionRate !== null && assisted.completionRate < current.completionRate) {
      failures.push(`${row.task}: assisted completion ${assisted.completionRate.toFixed(2)} is below the current viewer's ${current.completionRate.toFixed(2)}`);
    }
  }
  const wrong = sum(perTask.flatMap(row => Object.values(row.variants)), 'wrongTargetEffects');
  if (wrong > protocol.thresholds.maxWrongTargetEffects) failures.push(`${wrong} wrong-target effect(s) above the allowed ${protocol.thresholds.maxWrongTargetEffects}`);
  return { ...base, verdict: failures.length ? 'not-met' : 'met', failures,
    caveat: protocol.status === 'proposed' ? 'The thresholds are still proposed; ratify them before treating this as acceptance.' : null };
}
