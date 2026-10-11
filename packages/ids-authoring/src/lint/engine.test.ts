/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { docFromXml, entity, idsXml, property, specXml } from '../../test/lint-helpers.js';
import type { StudioDocument, Suppression } from '../document/types.js';
import { apply } from '../reducer/apply.js';
import { createLintContext } from './context.js';
import { createLinter, lintDocsUrl, lintDocument } from './engine.js';
import { checkQuickFix, fixIds, quickFix } from './fix.js';
import type { DocumentRule, LintContext, LintRule, SpecRule } from './types.js';
import { at } from './walk.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

let calls = 0;

/** Flags every property requirement; offers to make it optional. */
const PROBE: SpecRule = {
  code: 'IDSL-PROP-901',
  area: 'PROP',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'probe',
  rationale: 'test rule',
  check(spec) {
    calls++;
    return spec.requirements
      .filter((r) => r.facet.type === 'property')
      .map((r) => ({
        ...at(r, 'property.baseName'),
        message: 'probe',
        fixes: [
          quickFix('Make optional', 'IDSL-PROP-901', r.facetId, 'opt', [
            { kind: 'requirement.setOptionality', payload: { facetId: r.facetId, optionality: 'optional' } },
          ]),
        ],
      }));
  },
};

/** Flags the first specification of every document. */
const FIRST: DocumentRule = {
  code: 'IDSL-SPEC-901',
  area: 'SPEC',
  scope: 'document',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'first',
  rationale: 'test rule',
  check(specs) {
    return specs.length ? [{ nodeId: specs[0].nodes.requirements[0]?.id ?? specs[0].specId, message: 'first' }] : [];
  },
};

const REGISTRY: LintRule[] = [PROBE, FIRST];

function twoSpecs(): StudioDocument {
  const req = property('Pset_WallCommon', 'IsExternal');
  return docFromXml(idsXml(specXml(entity('IFCWALL'), req, 'ifcVersion="IFC4"', 'A') + specXml(entity('IFCSLAB'), property('Pset_SlabCommon', 'IsExternal'), 'ifcVersion="IFC4"', 'B')));
}

function withSuppressions(doc: StudioDocument, map: Record<string, Suppression[]>): StudioDocument {
  return { ...doc, meta: { ...doc.meta, suppressions: map } };
}

describe('registry', () => {
  it('rejects malformed, misfiled and duplicate codes', () => {
    expect(() => createLinter(ctx, { registry: [{ ...PROBE, code: 'IDSL-prop-1' }] })).toThrow(/IDSL-<AREA>-<nnn>/);
    expect(() => createLinter(ctx, { registry: [{ ...PROBE, area: 'ENT' }] })).toThrow(/filed under area/);
    expect(() => createLinter(ctx, { registry: [PROBE, PROBE] })).toThrow(/duplicate/);
  });

  it('filters by code and honours severity overrides, including off', () => {
    expect(createLinter(ctx, { registry: REGISTRY, rules: ['IDSL-SPEC-901'] }).rules.map((r) => r.code)).toEqual(['IDSL-SPEC-901']);
    expect(createLinter(ctx, { registry: REGISTRY, severity: { 'IDSL-SPEC-901': 'off' } }).rules.map((r) => r.code)).toEqual(['IDSL-PROP-901']);
    const r = lintDocument(twoSpecs(), ctx, { registry: REGISTRY, severity: { 'IDSL-PROP-901': 'error' } });
    expect(r.diagnostics.filter((d) => d.code === 'IDSL-PROP-901').map((d) => d.severity)).toEqual(['error', 'error']);
  });
});

describe('diagnostics', () => {
  it('stamps code, severity, docs url, rationale, spec and field', () => {
    const doc = twoSpecs();
    const { diagnostics } = lintDocument(doc, ctx, { registry: REGISTRY });
    expect(diagnostics.map((d) => d.code)).toEqual(['IDSL-PROP-901', 'IDSL-PROP-901', 'IDSL-SPEC-901']);
    const [first] = diagnostics;
    expect(first).toMatchObject({
      severity: 'warning',
      specId: doc.nodes.specs[0].id,
      field: 'property.baseName',
      nodeId: doc.nodes.specs[0].requirements[0].constraints['property.baseName'],
      why: 'test rule',
      docsUrl: 'https://ifclite.dev/docs/guide/ids-lint/idsl-prop-901/',
    });
    expect(lintDocsUrl('IDSL-ENT-001')).toBe('https://ifclite.dev/docs/guide/ids-lint/idsl-ent-001/');
    // A document-rule finding on a requirement is attributed to its spec.
    expect(diagnostics[2].specId).toBe(doc.nodes.specs[0].id);
  });

  it('is deterministic, including quick-fix op ids', () => {
    const a = lintDocument(twoSpecs(), ctx, { registry: REGISTRY });
    const b = lintDocument(twoSpecs(), ctx, { registry: REGISTRY });
    expect(a).toEqual(b);
    expect(fixIds('X', 'n')()).toBe(fixIds('X', 'n')());
    expect(fixIds('X', 'n', 'a')()).not.toBe(fixIds('X', 'n', 'b')());
  });

  it('emits quick fixes that pass the gate and resolve the finding when applied', () => {
    const doc = twoSpecs();
    const d = lintDocument(doc, ctx, { registry: REGISTRY }).diagnostics[0];
    const fix = d.fixes![0];
    expect(checkQuickFix(doc, fix, ctx.gate)).toEqual({ ok: true, issues: [] });
    const after = apply(doc, fix.ops).doc;
    expect(after.ids.specifications[0].requirements[0].optionality).toBe('optional');
  });
});

describe('incremental re-lint', () => {
  it('re-runs spec rules only for specifications that changed', () => {
    const doc = twoSpecs();
    const linter = createLinter(ctx, { registry: REGISTRY });
    calls = 0;
    const r1 = linter.lint(doc);
    expect(r1.stats).toEqual({ specsLinted: 2, specsReused: 0 });
    const facetId = doc.nodes.specs[1].requirements[0].id;
    const { doc: next, touched } = apply(doc, [{ kind: 'requirement.setOptionality', opId: fixIds('t', 't')(), payload: { facetId, optionality: 'optional' } }]);
    const r2 = linter.lint(next, { touched });
    expect(r2.stats).toEqual({ specsLinted: 1, specsReused: 1 });
    expect(calls).toBe(3);
    expect(r2.diagnostics).toEqual(lintDocument(next, ctx, { registry: REGISTRY }).diagnostics);
    // Nothing changed: everything reused.
    expect(linter.lint(next).stats).toEqual({ specsLinted: 0, specsReused: 2 });
  });

  it('detects a changed specification by identity, without a touched hint', () => {
    const doc = twoSpecs();
    const linter = createLinter(ctx, { registry: REGISTRY });
    linter.lint(doc);
    const facetId = doc.nodes.specs[0].requirements[0].id;
    // A new specification object under the SAME node index object (e.g. a host
    // that rebuilt the IDS content): only identity of the spec reveals it.
    const [first, ...rest] = doc.ids.specifications;
    const changed = { ...first, requirements: first.requirements.map((r) => (r.id === facetId ? { ...r, optionality: 'optional' as const } : r)) };
    const next: StudioDocument = { ...doc, ids: { ...doc.ids, specifications: [changed, ...rest] } };
    const r = linter.lint(next);
    expect(r.stats).toEqual({ specsLinted: 1, specsReused: 1 });
  });

  it('honours an explicit touched hint and invalidates on custom declarations', () => {
    const doc = twoSpecs();
    const linter = createLinter(ctx, { registry: REGISTRY });
    linter.lint(doc);
    expect(linter.lint(doc, { touched: [doc.nodes.specs[0].applicability[0].id] }).stats).toEqual({ specsLinted: 1, specsReused: 1 });
    const declared = { ...doc, meta: { ...doc.meta, custom: { psets: [{ name: 'X' }], userDefinedTypes: [] } } };
    expect(linter.lint(declared).stats).toEqual({ specsLinted: 2, specsReused: 0 });
  });

  it('drops cached findings of removed specifications', () => {
    const doc = twoSpecs();
    const linter = createLinter(ctx, { registry: REGISTRY });
    linter.lint(doc);
    const { doc: next } = apply(doc, [{ kind: 'spec.remove', opId: fixIds('t', 'r')(), payload: { specId: doc.nodes.specs[0].id } }]);
    const r = linter.lint(next);
    expect(r.stats).toEqual({ specsLinted: 0, specsReused: 1 });
    expect(r.diagnostics.map((d) => d.specId)).toEqual([next.nodes.specs[0].id, next.nodes.specs[0].id]);
  });
});

describe('suppressions', () => {
  const s = (rule: string, reason = 'agreed with the client'): Suppression => ({ rule, reason, at: '2026-10-08T00:00:00Z' });

  it('suppress on the node itself, on an ancestor and by area wildcard', () => {
    const doc = twoSpecs();
    const spec0 = doc.nodes.specs[0];
    const onNode = lintDocument(withSuppressions(doc, { [spec0.requirements[0].constraints['property.baseName']!]: [s('IDSL-PROP-901')] }), ctx, { registry: REGISTRY });
    expect(onNode.diagnostics.map((d) => d.code)).toEqual(['IDSL-PROP-901', 'IDSL-SPEC-901']);
    expect(onNode.suppressed).toHaveLength(1);
    const onSpec = lintDocument(withSuppressions(doc, { [spec0.id]: [s('IDSL-PROP-*')] }), ctx, { registry: REGISTRY });
    expect(onSpec.suppressed.map((x) => x.suppressedAt)).toEqual([spec0.id]);
    const onDoc = lintDocument(withSuppressions(doc, { [doc.nodes.document]: [s('IDSL-PROP-901'), s('IDSL-SPEC-901')] }), ctx, { registry: REGISTRY });
    expect(onDoc.diagnostics).toEqual([]);
    expect(onDoc.suppressed).toHaveLength(3);
  });

  it('ignores a suppression without a reason, and one for another rule', () => {
    const doc = twoSpecs();
    const r = lintDocument(withSuppressions(doc, { [doc.nodes.document]: [s('IDSL-PROP-901', '  '), s('IDSL-ENT-001')] }), ctx, { registry: REGISTRY });
    expect(r.diagnostics).toHaveLength(3);
    expect(r.suppressed).toEqual([]);
  });
});
