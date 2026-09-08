/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { DirtyPrScanError } from './dirty-pr-scan.mjs';

/**
 * `topLevelTriggerNames` reads the trigger keys directly under a workflow's
 * top-level `on:` block ('push', 'workflow_dispatch', 'schedule', ...).
 *
 * Exists so `scripts/scan-dirty-prs.test.mjs`'s #3776 regression ("the scan
 * has a trigger that does not depend on GitHub cron delivery") can assert on
 * a PARSED trigger list instead of matching regexes against the workflow's
 * raw text -- the latter is exactly the pattern
 * `scripts/check-source-text-assertions.mjs` (#2434) exists to ratchet out,
 * because it certifies that a string of the right shape exists in the file
 * rather than that the workflow actually behaves the way the test claims.
 *
 * `requiredWorkflowTriggers` below does the file read itself so that no test
 * file ever calls `readFileSync` on the workflow and passes the bytes to a
 * predicate directly; this function stays pure and is exercised with literal
 * fixture text in `scripts/lib/workflow-triggers.test.mjs`.
 *
 * Handles every shape YAML allows for the `on:` key and its value: block
 * mapping (`on:\n  push:\n  workflow_dispatch:`), scalar (`on: push`), flow
 * sequence (`on: [push, workflow_dispatch]`), and a quoted key (`"on":` /
 * `'on':` -- unquoted `on` parses as the boolean `true` in YAML 1.1, so some
 * workflows quote it). For the block-mapping form, the indent of the FIRST
 * child line is what determines a sibling trigger versus a nested key (e.g.
 * `branches:` under `push:`) -- not a hardcoded two spaces, so 4-space or
 * tab-indented workflows parse the same as 2-space ones.
 *
 * @param {string} text - a GitHub Actions workflow file's contents.
 * @returns {string[]} the trigger keys under `on:`, in file order.
 */
export function topLevelTriggerNames(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new DirtyPrScanError('NO_WORKFLOW_TEXT', 'The workflow text is empty, so its triggers cannot be read.');
  }
  const lines = text.split(/\r?\n/);

  const onLineRe = /^(?:"on"|'on'|on):(.*)$/;
  const start = lines.findIndex((l) => onLineRe.test(l));
  if (start === -1) {
    throw new DirtyPrScanError('NO_ON_BLOCK', 'The workflow has no top-level `on:` key, so its triggers cannot be read.');
  }

  const inline = stripComment(onLineRe.exec(lines[start])[1]).trim();
  if (inline !== '') {
    const names = inline.startsWith('[') ? splitFlowList(inline.slice(1, inline.indexOf(']') === -1 ? undefined : inline.indexOf(']'))) : [stripQuotes(inline)];
    const filtered = names.filter((n) => n !== '');
    if (filtered.length === 0) {
      throw new DirtyPrScanError('NO_TRIGGERS', 'The workflow`s `on:` value declares no trigger keys.');
    }
    return filtered;
  }

  // Block-mapping form: learn the child indent from the first non-blank,
  // non-comment line after `on:`, rather than assuming any particular width.
  let i = start + 1;
  while (i < lines.length && (lines[i].trim() === '' || /^\s*#/.test(lines[i]))) i += 1;
  const first = lines[i];
  if (i >= lines.length || first === undefined || !/^\s+\S/.test(first)) {
    throw new DirtyPrScanError('NO_TRIGGERS', 'The workflow`s `on:` block declares no trigger keys.');
  }
  const indent = first.length - first.trimStart().length;

  const names = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const lineIndent = line.length - line.trimStart().length;
    // Shallower than the first child: the next top-level workflow key
    // (`jobs:`, `concurrency:`, ...) ends the `on:` block.
    if (lineIndent < indent) break;
    // Deeper than the first child: a nested key (e.g. `branches:`) belonging
    // to the trigger just collected, not a sibling trigger.
    if (lineIndent > indent) continue;
    const m = /^\s*(?:"([\w-]+)"|'([\w-]+)'|([A-Za-z_][\w-]*)):/.exec(line);
    if (m) names.push(m[1] ?? m[2] ?? m[3]);
  }
  if (names.length === 0) {
    throw new DirtyPrScanError('NO_TRIGGERS', 'The workflow`s `on:` block declares no trigger keys.');
  }
  return names;
}

/** Drops a trailing `# comment`, but only one preceded by whitespace or the string start, so a `#` inside a quoted value (e.g. a cron string) survives. */
function stripComment(s) {
  const m = /(^|\s)#.*$/.exec(s);
  return m ? s.slice(0, m.index) : s;
}

/** @param {string} raw */
function splitFlowList(raw) {
  return raw
    .split(',')
    .map((v) => stripQuotes(v.trim()))
    .filter((v) => v !== '');
}

/** @param {string} v */
function stripQuotes(v) {
  return v.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * `topLevelTriggerNames`, reading the workflow file itself. Kept separate so
 * that a caller which only wants to assert on the parsed trigger list -- as
 * opposed to unit-testing the parser against hand-written fixtures -- never
 * needs its own `readFileSync` call.
 *
 * @param {string} workflowPath - absolute path to a workflow YAML file.
 * @returns {string[]}
 */
export function requiredWorkflowTriggers(workflowPath) {
  return topLevelTriggerNames(readFileSync(workflowPath, 'utf8'));
}
