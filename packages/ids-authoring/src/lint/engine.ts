/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lint engine (03-diagnostics-audit-lint.md §4).
 *
 * Rules are pure functions registered with metadata. Spec-scoped rules run
 * per specification and their findings are cached; a later pass re-runs
 * them only for specifications that changed. "Changed" is decided by
 * object identity, which is sound because the reducer shares structure:
 * an op that does not touch a specification hands back the very same
 * `IDSSpecification` and `SpecNodes` objects. Callers may also pass the
 * reducer's `touched` set as an explicit hint. Document-scoped rules
 * (duplicates, overlaps, document info) run on every pass.
 *
 * Suppressions are applied after the cache, so adding one never forces a
 * re-run.
 */

import type { IDSSpecification } from '@ifc-lite/ids';
import type { SpecNodes, StudioMeta, StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import { LINT_RULES } from './rules/index.js';
import { applySuppressions } from './suppress.js';
import type {
  Diagnostic,
  DocumentRule,
  Finding,
  LintContext,
  LintOptions,
  LintResult,
  LintRule,
  LintSeverity,
  SpecRule,
} from './types.js';
import { specView } from './walk.js';

export const LINT_DOCS_BASE = 'https://ifclite.dev/docs/guide/ids-lint/';

const CODE = /^IDSL-[A-Z]+-\d{3}$/;

export function lintDocsUrl(code: string): string {
  return `${LINT_DOCS_BASE}${code.toLowerCase()}/`;
}

interface CacheEntry {
  spec: IDSSpecification;
  nodes: SpecNodes;
  custom: StudioMeta['custom'];
  diagnostics: Diagnostic[];
}

export interface Linter {
  /** The active rules, in registry order. */
  readonly rules: readonly LintRule[];
  lint(doc: StudioDocument, hint?: { touched?: Iterable<Uuid> }): LintResult;
}

export interface LinterOptions extends LintOptions {
  /** The rule registry to draw from (default: the full catalogue). */
  registry?: readonly LintRule[];
}

function validateRegistry(registry: readonly LintRule[]): void {
  const seen = new Set<string>();
  for (const r of registry) {
    if (!CODE.test(r.code)) throw new Error(`lint rule code "${r.code}" does not match IDSL-<AREA>-<nnn>`);
    if (!r.code.startsWith(`IDSL-${r.area}-`)) throw new Error(`lint rule ${r.code} is filed under area ${r.area}`);
    if (seen.has(r.code)) throw new Error(`duplicate lint rule code ${r.code}`);
    seen.add(r.code);
  }
}

function specTouched(nodes: SpecNodes, touched: ReadonlySet<Uuid>): boolean {
  if (touched.size === 0) return false;
  if (touched.has(nodes.id)) return true;
  for (const f of [...nodes.applicability, ...nodes.requirements]) {
    if (touched.has(f.id)) return true;
    for (const c of Object.values(f.constraints)) if (c && touched.has(c)) return true;
  }
  return false;
}

/** Create an incremental linter. Keep one per open document. */
export function createLinter(ctx: LintContext, options: LinterOptions = {}): Linter {
  const registry = options.registry ?? LINT_RULES;
  validateRegistry(registry);
  const only = options.rules ? new Set(options.rules) : undefined;
  const severityOf = (r: LintRule): LintSeverity | 'off' => options.severity?.[r.code] ?? r.defaultSeverity;
  const rules = registry.filter((r) => (!only || only.has(r.code)) && severityOf(r) !== 'off');
  const specRules = rules.filter((r): r is SpecRule => r.scope === 'spec');
  const docRules = rules.filter((r): r is DocumentRule => r.scope === 'document');
  const cache = new Map<Uuid, CacheEntry>();

  const stamp = (rule: LintRule, f: Finding, specId: Uuid | undefined): Diagnostic => {
    const d: Diagnostic = {
      code: rule.code,
      severity: severityOf(rule) as LintSeverity,
      nodeId: f.nodeId,
      message: f.message,
      why: rule.rationale,
      docsUrl: lintDocsUrl(rule.code),
    };
    if (specId) d.specId = specId;
    if (f.field) d.field = f.field;
    if (f.fixes?.length) d.fixes = f.fixes;
    return d;
  };

  return {
    rules,
    lint(doc, hint = {}) {
      const touched = new Set(hint.touched ?? []);
      const input = { ctx, doc };
      const views = doc.ids.specifications.map((s, i) => specView(s, doc.nodes.specs[i], i));
      const next = new Map<Uuid, CacheEntry>();
      const diagnostics: Diagnostic[] = [];
      let specsLinted = 0;
      for (const view of views) {
        const prior = cache.get(view.specId);
        const reusable =
          prior &&
          prior.spec === view.spec &&
          prior.nodes === view.nodes &&
          prior.custom === doc.meta.custom &&
          !specTouched(view.nodes, touched);
        let entry: CacheEntry;
        if (reusable) {
          entry = prior;
        } else {
          specsLinted++;
          const found = specRules.flatMap((r) => r.check(view, input).map((f) => stamp(r, f, view.specId)));
          entry = { spec: view.spec, nodes: view.nodes, custom: doc.meta.custom, diagnostics: found };
        }
        next.set(view.specId, entry);
        diagnostics.push(...entry.diagnostics);
      }
      cache.clear();
      for (const [k, v] of next) cache.set(k, v);
      const specOf = new Map(views.map((v) => [v.specId, v.specId]));
      for (const r of docRules) {
        for (const f of r.check(views, input)) {
          const owner = specOf.get(f.nodeId) ?? views.find((v) => ownsNode(v.nodes, f.nodeId))?.specId;
          diagnostics.push(stamp(r, f, owner));
        }
      }
      const { active, suppressed } = applySuppressions(doc, diagnostics);
      return { diagnostics: active, suppressed, stats: { specsLinted, specsReused: views.length - specsLinted } };
    },
  };
}

function ownsNode(nodes: SpecNodes, id: Uuid): boolean {
  return specTouched(nodes, new Set([id]));
}

/** One-shot lint of a whole document (no cache reuse). */
export function lintDocument(doc: StudioDocument, ctx: LintContext, options: LinterOptions = {}): LintResult {
  return createLinter(ctx, options).lint(doc);
}
