/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detectors behind scripts/check-perf-flags.mjs (#6962). Two independent
 * checks, both on a real TypeScript parse/scan rather than regexes:
 *
 *   1. `checkRegistry` reads the `PERF_FLAGS` array literal out of
 *      apps/viewer/src/lib/perf/flags.ts and rejects a flag with no owner or
 *      removal condition, an unknown kind, a bad or duplicate id, an
 *      unparsable `introducedAt`, or a RAMP more than four weeks past its
 *      `introducedAt` (a ramp is a rollout, not a resting state).
 *   2. `findPerfGlobalReads` lists `__IFC_LITE_*` property accesses in a
 *      source file: identifiers (`g.__IFC_LITE_X`, `{ __IFC_LITE_X?: T }`) and
 *      string literals that are exactly a global name (`g['__IFC_LITE_X']`).
 *      Comments and prose strings ("ignoring invalid __IFC_LITE_X: ...") are
 *      not reads, so they are not reported.
 */

import ts from 'typescript';

export const RAMP_MAX_AGE_DAYS = 28;
export const FLAG_KINDS = new Set(['kill-switch', 'ramp']);
const GLOBAL_NAME = /^__IFC_LITE_[A-Z0-9_]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function unwrap(node) {
  let current = node;
  while (
    current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current))
  ) current = current.expression;
  return current;
}

function propertyName(prop) {
  if (!prop.name) return null;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  return null;
}

/** String-literal metadata fields of each `PERF_FLAGS` element. */
export function parseRegistry(source, fileName = 'flags.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let array = null;
  const visit = (node) => {
    if (array) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'PERF_FLAGS') {
      const init = unwrap(node.initializer);
      if (init && ts.isArrayLiteralExpression(init)) array = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!array) throw new Error(`${fileName}: no \`PERF_FLAGS\` array literal found`);
  return array.elements.map((element) => {
    const line = sf.getLineAndCharacterOfPosition(element.getStart(sf)).line + 1;
    const entry = { line, fields: {} };
    const object = unwrap(element);
    if (!ts.isObjectLiteralExpression(object)) return { ...entry, notLiteral: true };
    for (const prop of object.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propertyName(prop);
      const value = unwrap(prop.initializer);
      if (name && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
        entry.fields[name] = value.text;
      } else if (name) {
        entry.fields[name] = null; // present but not a plain string
      }
    }
    return entry;
  });
}

/** Human-readable problems with the registry; empty means it passes. */
export function checkRegistry(source, { today = new Date(), fileName = 'flags.ts' } = {}) {
  const problems = [];
  const entries = parseRegistry(source, fileName);
  if (entries.length === 0) problems.push(`${fileName}: PERF_FLAGS is empty`);
  const seen = new Set();
  for (const { line, fields, notLiteral } of entries) {
    const at = `${fileName}:${line}`;
    if (notLiteral) {
      problems.push(`${at}: every PERF_FLAGS entry must be an object literal so this lint can read it`);
      continue;
    }
    const id = fields.id;
    const label = id ? `${at} (${id})` : at;
    if (typeof id !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(id)) problems.push(`${label}: missing or non-camelCase id`);
    else if (seen.has(id)) problems.push(`${label}: duplicate id`);
    else seen.add(id);
    if (!FLAG_KINDS.has(fields.kind)) problems.push(`${label}: kind must be 'kill-switch' or 'ramp'`);
    for (const key of ['owner', 'removalCondition']) {
      if (typeof fields[key] !== 'string' || fields[key].trim() === '') problems.push(`${label}: missing ${key}`);
    }
    const introduced = typeof fields.introducedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fields.introducedAt)
      ? Date.parse(`${fields.introducedAt}T00:00:00Z`)
      : Number.NaN;
    if (!Number.isFinite(introduced)) {
      problems.push(`${label}: introducedAt must be an ISO date (YYYY-MM-DD)`);
      continue;
    }
    if (fields.kind === 'ramp') {
      const ageDays = Math.floor((today.getTime() - introduced) / DAY_MS);
      if (ageDays > RAMP_MAX_AGE_DAYS) {
        problems.push(
          `${label}: ramp is ${ageDays} days past introducedAt ${fields.introducedAt} (limit ${RAMP_MAX_AGE_DAYS}). ` +
          'Finish it: promote to the default and delete the flag, or demote it to a kill-switch with a removal condition.',
        );
      }
    }
  }
  return problems;
}

/** `__IFC_LITE_*` reads in one source file, as `{ line, name }`. */
export function findPerfGlobalReads(source, fileName) {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX
    : /\.jsx$/.test(fileName) ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  const visit = (node) => {
    let name = null;
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text.startsWith('__IFC_LITE_')) name = node.text;
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && GLOBAL_NAME.test(node.text)) name = node.text;
    if (name) hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, name });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
