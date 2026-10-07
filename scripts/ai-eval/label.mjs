#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Human labelling tool for the AI evaluation (#6928). Labels are produced by
 * people; this tool only builds the sheets, validates them against the
 * recording they came from, and scores agreement.
 *
 *   label.mjs sheet --recording <id|file> --kind claims|grouping --reviewer <pseudonym> [--out <file>]
 *       A blank sheet. Fill it in with scripts/ai-eval/label-tool.html (or by hand) and save it
 *       under tests/ai-eval/labels/ once reviewed.
 *   label.mjs check <sheet.json>...      Validate sheets against the schema and their recording.
 *   label.mjs score <sheet.json>...      Agreement per recording and kind (kappa for claims, ARI for grouping).
 *
 * Sheets under tests/ai-eval/labels are also validated by check-ai-eval-manifest.mjs.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSheet, answerSha256, scoreSheets, sheetErrors } from './lib/labels.mjs';
import { decodeRecording, loadRecordingDir, REPO_ROOT, RECORDINGS_DIR } from './lib/recording.mjs';
import { privacyFindings } from './lib/manifest.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'ai-eval', 'label-sheet.schema.json'), 'utf8'));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** Errors for parsed sheets against the recordings they claim to label. `[{ name, sheet }]`. */
export function sheetFileErrors(files, recordings, schema = SCHEMA) {
  const byId = new Map(recordings.map(({ recording }) => [recording.id, recording]));
  const errors = [];
  for (const { name, sheet } of files) {
    for (const error of sheetErrors(sheet, schema)) errors.push(`label ${name}: ${error}`);
    // Notes and group names are free text a reviewer typed: scanned like study sessions and live output before committing.
    const findings = privacyFindings(JSON.stringify(sheet), 'json');
    if (findings.length) errors.push(`label ${name}: privacy scan: ${findings.join('; ')}`);
    const recording = byId.get(sheet.recording);
    if (!recording) { errors.push(`label ${name}: unknown recording ${sheet.recording}`); continue; }
    if (recording.task !== sheet.task) errors.push(`label ${name}: task ${sheet.task} differs from the recording's ${recording.task}`);
    if (recording.corpus === 'negative') errors.push(`label ${name}: negative recordings are detector tests, not label material`);
    const answer = decodeRecording(recording).text;
    if (answerSha256(answer) !== sheet.answerSha256) errors.push(`label ${name}: the recorded answer changed since this sheet was made`);
    if (sheet.kind === 'claims' && sheet.claims) {
      const rebuilt = buildSheet({ recording, kind: 'claims', answer, reviewerId: 'x' }).claims;
      if (JSON.stringify(rebuilt.map(claim => claim.text)) !== JSON.stringify(sheet.claims.map(claim => claim.text))) errors.push(`label ${name}: claim text no longer matches the answer`);
    }
    if (sheet.kind === 'grouping' && Array.isArray(sheet.findings) && sheet.proposal) {
      // The findings and the proposal are what the score is computed from: they must be the recording's, unedited.
      let rebuilt = null;
      try { rebuilt = buildSheet({ recording, kind: 'grouping', answer, reviewerId: 'x' }); }
      catch (error) { errors.push(`label ${name}: ${error instanceof Error ? error.message : String(error)}`); }
      if (rebuilt) {
        if (JSON.stringify(rebuilt.findings.map(finding => finding.citation)) !== JSON.stringify(sheet.findings.map(finding => finding.citation))) errors.push(`label ${name}: finding citations no longer match the recording`);
        const proposal = groups => JSON.stringify(groups.map(group => [group.name, group.citations]));
        if (proposal(rebuilt.proposal.groups) !== proposal(sheet.proposal.groups ?? [])) errors.push(`label ${name}: the proposal no longer matches the recorded answer`);
      }
    }
  }
  return errors;
}

/** Sheets committed under tests/ai-eval/labels (none yet is normal until people label). */
export function loadLabelDir(root) {
  const dir = join(root, 'tests', 'ai-eval', 'labels');
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => ({ name, sheet: readJson(join(dir, name)) })) : [];
}

function flag(args, name) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

function main([command, ...args]) {
  const recordings = loadRecordingDir(RECORDINGS_DIR);
  if (command === 'sheet') {
    const id = flag(args, 'recording');
    const kind = flag(args, 'kind');
    const reviewerId = flag(args, 'reviewer');
    if (!id || !['claims', 'grouping'].includes(kind) || !reviewerId) throw new Error('Usage: label.mjs sheet --recording <id> --kind claims|grouping --reviewer <pseudonym> [--out <file>]');
    const found = recordings.find(({ recording, name }) => recording.id === id || name === id || name === `${id}.json`);
    if (!found) throw new Error(`No recording ${id}`);
    const sheet = buildSheet({ recording: found.recording, kind, answer: decodeRecording(found.recording).text, reviewerId });
    const errors = sheetErrors(sheet, SCHEMA);
    if (errors.length) throw new Error(errors.join('; '));
    const out = flag(args, 'out');
    const text = `${JSON.stringify(sheet, null, 2)}\n`;
    if (out) writeFileSync(resolve(out), text); else process.stdout.write(text);
    return 0;
  }
  const paths = args.filter(arg => !arg.startsWith('--'));
  const files = paths.map(path => ({ name: path, sheet: readJson(resolve(path)) }));
  if (command === 'check') {
    const errors = sheetFileErrors(files, recordings);
    for (const error of errors) console.error(error);
    console.log(errors.length ? `label check: ${errors.length} problem(s)` : `label check: ${files.length} sheet(s) OK`);
    return errors.length ? 1 : 0;
  }
  if (command === 'score') {
    const errors = sheetFileErrors(files, recordings);
    if (errors.length) { errors.forEach(error => console.error(error)); return 1; }
    const groups = new Map();
    for (const { sheet } of files) groups.set(`${sheet.recording}\u0000${sheet.kind}`, [...(groups.get(`${sheet.recording}\u0000${sheet.kind}`) ?? []), sheet]);
    const report = [...groups].map(([key, sheets]) => ({ recording: key.split('\u0000')[0], ...scoreSheets(sheets) }));
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  throw new Error('Usage: label.mjs sheet|check|score ...');
}

if (isMainEntry(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
