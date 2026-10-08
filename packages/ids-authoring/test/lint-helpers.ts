/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint fixtures are written as IDS XML (the form authors and the docs use),
 * parsed with the real parser and wrapped as a Studio document with
 * deterministic ids.
 */

import { auditIDSStructure, parseIDS } from '@ifc-lite/ids';
import { expect } from 'vitest';
import { fromIdsDocument } from '../src/document/from-ids.js';
import type { StudioDocument, StudioMeta } from '../src/document/types.js';
import { emptyMeta } from '../src/document/types.js';
import { checkOps } from '../src/gate/check.js';
import { createLinter } from '../src/lint/engine.js';
import { LINT_RULES } from '../src/lint/rules/index.js';
import type { Diagnostic, LintContext, LintRule } from '../src/lint/types.js';
import { apply } from '../src/reducer/apply.js';
import { counterIds } from './corpus.js';

const NS = 'xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';

/** A whole IDS document around `specsXml`, with optional extra `<info>` children. */
export function idsXml(specsXml: string, info = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><ids ${NS}><info><title>Fixture</title>${info}</info><specifications>${specsXml}</specifications></ids>`;
}

/** One specification. `app` and `req` are facet XML; `req` may be empty. */
export function specXml(app: string, req = '', attrs = 'ifcVersion="IFC4"', name = 'S'): string {
  return `<specification name="${name}" ${attrs}><applicability minOccurs="0" maxOccurs="unbounded">${app}</applicability>${req ? `<requirements>${req}</requirements>` : ''}</specification>`;
}

export const sv = (v: string): string => `<simpleValue>${v}</simpleValue>`;
export const entity = (name: string, pdt?: string): string => `<entity><name>${sv(name)}</name>${pdt ? `<predefinedType>${sv(pdt)}</predefinedType>` : ''}</entity>`;
export const restriction = (base: string, inner: string): string => `<xs:restriction base="${base}">${inner}</xs:restriction>`;
export const enumeration = (values: string[], base = 'xs:string'): string => restriction(base, values.map((v) => `<xs:enumeration value="${v}"/>`).join(''));
export const pattern = (p: string, base = 'xs:string'): string => restriction(base, `<xs:pattern value="${p}"/>`);

export function property(pset: string, name: string, opts: { value?: string; dataType?: string; cardinality?: string } = {}): string {
  const attrs = [opts.dataType ? `dataType="${opts.dataType}"` : '', opts.cardinality ? `cardinality="${opts.cardinality}"` : ''].join(' ');
  return `<property ${attrs}><propertySet>${sv(pset)}</propertySet><baseName>${sv(name)}</baseName>${opts.value ? `<value>${opts.value}</value>` : ''}</property>`;
}

export function attribute(name: string, value?: string, cardinality?: string): string {
  return `<attribute${cardinality ? ` cardinality="${cardinality}"` : ''}><name>${sv(name)}</name>${value ? `<value>${value}</value>` : ''}</attribute>`;
}

export function docFromXml(xml: string, meta?: StudioMeta): StudioDocument {
  return fromIdsDocument(parseIDS(xml), { newId: counterIds(0x11e7), meta: meta ?? emptyMeta() });
}

/** Lint `xml` with only `code` enabled. */
export function lintCode(ctx: LintContext, code: string, xml: string | StudioDocument): { doc: StudioDocument; diagnostics: Diagnostic[] } {
  const doc = typeof xml === 'string' ? docFromXml(xml) : xml;
  return { doc, diagnostics: createLinter(ctx, { rules: [code] }).lint(doc).diagnostics };
}

export function ruleOf(code: string): LintRule {
  const rule = LINT_RULES.find((r) => r.code === code);
  if (!rule) throw new Error(`no rule ${code}`);
  return rule;
}

/**
 * The quick-fix contract: every fix passes the gate, applying it clears
 * the diagnostic it was offered for, and the audit raises no new errors.
 */
export async function expectFixesWork(ctx: LintContext, doc: StudioDocument, d: Diagnostic): Promise<void> {
  const before = await auditIDSStructure(doc.ids);
  const beforeErrors = before.issues.filter((i) => i.severity === 'error').length;
  for (const fix of d.fixes ?? []) {
    const gate = checkOps(fix.ops, doc, ctx.gate);
    expect(gate.issues, `${d.code} fix "${fix.label}" must pass the gate`).toEqual([]);
    const after = apply(doc, fix.ops).doc;
    const again = createLinter(ctx, { rules: [d.code] }).lint(after).diagnostics;
    const same = again.filter((x) => x.nodeId === d.nodeId && x.message === d.message);
    expect(same, `${d.code} fix "${fix.label}" must clear the finding`).toEqual([]);
    const audit = await auditIDSStructure(after.ids);
    expect(audit.issues.filter((i) => i.severity === 'error').length, `${d.code} fix "${fix.label}" must not add audit errors`).toBeLessThanOrEqual(beforeErrors);
  }
}
