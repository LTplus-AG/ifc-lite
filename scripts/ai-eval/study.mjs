#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * U01 coordinator study CLI (#6928).
 *
 *   study.mjs check     Validate the protocol and every session record in tests/ai-eval/study/sessions.
 *   study.mjs summary   Measures per task and variant, and the threshold verdict (insufficient-data until
 *                       every role has the protocol's minimum participants).
 *   study.mjs script    Print the facilitator script for every task (prompts, start states, criteria, caps).
 *
 * Session records are one JSON file per participant x task x variant, written by the facilitator.
 * Protocol: docs/architecture/viewer-ai-evaluation.md.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { protocolErrors, sessionErrors, summarize } from './lib/study.mjs';
import { REPO_ROOT } from './lib/recording.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export function loadStudy(root) {
  const dir = join(root, 'tests', 'ai-eval', 'study');
  const sessionsDir = join(dir, 'sessions');
  return { protocol: readJson(join(dir, 'protocol.json')), schema: readJson(join(dir, 'session.schema.json')),
    manifest: readJson(join(root, 'tests', 'ai-eval', 'manifest.json')),
    sessions: existsSync(sessionsDir) ? readdirSync(sessionsDir).filter(name => name.endsWith('.json')).sort().map(name => ({ name, session: readJson(join(sessionsDir, name)) })) : [] };
}

export function facilitatorScript(protocol) {
  const lines = [`# Coordinator study script (protocol ${protocol.status})`, '', protocol.design, ''];
  for (const task of protocol.tasks) {
    lines.push(`## ${task.title} (${task.id}, cap ${task.capSeconds}s, roles: ${task.roles.join(', ')})`, '',
      `Start state: ${task.startState}`, `Say verbatim: "${task.participantPrompt}"`, 'Success criteria:', ...task.success.map(item => `  - ${item}`),
      `Expected entry, current: ${task.entry.current.group} / ${task.entry.current.panels.join(', ')}; assisted: ${task.entry.assisted.group} / ${task.entry.assisted.panels.join(', ')}`, '');
  }
  return lines.join('\n');
}

if (isMainEntry(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const at = rest.indexOf('--root');
  const root = at >= 0 ? resolve(rest[at + 1]) : REPO_ROOT;
  const { protocol, schema, manifest, sessions } = loadStudy(root);
  if (command === 'script') console.log(facilitatorScript(protocol));
  else if (command === 'check' || command === 'summary') {
    const errors = [...protocolErrors(protocol, { root, manifest }), ...sessionErrors(sessions, protocol, schema)];
    if (errors.length) { console.error(`study ${command}: ${errors.length} problem(s)\n${errors.map(error => `  - ${error}`).join('\n')}`); process.exitCode = 1; }
    else if (command === 'check') console.log(`study check: protocol (${protocol.tasks.length} tasks, status ${protocol.status}) and ${sessions.length} session(s) OK`);
    else console.log(JSON.stringify(summarize(protocol, sessions.map(item => item.session)), null, 2));
  } else { console.error('Usage: study.mjs check|summary|script [--root <repo>]'); process.exitCode = 1; }
}
