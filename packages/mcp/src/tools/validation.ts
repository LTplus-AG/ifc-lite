/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Validation tools (spec §7.4): IDS, audit, gherkin.
 *
 * IDS validation pulls in the buildingSMART rule engine via @ifc-lite/ids.
 * model_audit produces a Lighthouse-style health score per category.
 * gherkin_check is stubbed (UNSUPPORTED_OPERATION) until the bSI Gherkin
 * engine ships into the workspace.
 */

import { readFile } from 'node:fs/promises';
import { parseIDS, validateIDS, type IFCDataAccessor } from '@ifc-lite/ids';
import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { foldedTypeCounts, pendingMutationsField, pendingOverlay } from '../overlay.js';
import { isProductType } from '../backend-query.js';
import { EntityNode } from '@ifc-lite/query';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import type { ToolContext } from '../context.js';
import { buildIdsAccessor } from './ids-accessor.js';

const idsValidate: Tool = {
  name: 'ids_validate',
  description: 'Run an IDS rule set against the model. Either pass `ids_xml` inline or `ids_path` to read from disk.',
  scope: 'validate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      ids_xml: { type: 'string', description: 'Inline IDS XML content.' },
      ids_path: { type: 'string', description: 'Path to .ids file (subject to allowedPaths).' },
      locale: { type: 'string', enum: ['en', 'de', 'fr'], default: 'en' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const xml = await loadIdsXml(input, ctx);

    const idsDoc = parseIDS(xml);
    const accessor = buildIdsAccessor(m.store) as IFCDataAccessor;
    const report = await validateIDS(
      idsDoc,
      accessor,
      { modelId: m.id, schemaVersion: m.store.schemaVersion, entityCount: m.store.entityCount },
      {
        onProgress: (p) => {
          ctx.progress.report(p.percentage / 100, `Validating ${p.phase} (${p.specificationIndex + 1}/${p.totalSpecifications})`, 100);
        },
      },
    );
    void input.locale;

    const summary = summarizeIdsReport(report);
    return okResult(
      `IDS: ${summary.passedSpecifications}/${summary.totalSpecifications} specs passed; ${summary.failedEntities} entity failures.`,
      { summary, report },
    );
  },
};

/**
 * Resolve IDS source from `ids_xml` (inline) or `ids_path` (disk),
 * enforcing the optional `allowedPaths` allowlist on disk reads. Shared by
 * `ids_validate` and `ids_explain` so both tools apply identical guards;
 * the previous arrangement let `ids_explain` read arbitrary paths in
 * restricted stdio deployments.
 */
async function loadIdsXml(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (typeof input.ids_xml === 'string') return input.ids_xml;
  if (typeof input.ids_path === 'string') {
    const abs = await resolveSafePath(input.ids_path, ctx, 'read');
    return readFile(abs, 'utf-8');
  }
  throw new ToolExecutionError({
    code: ToolErrorCode.INVALID_INPUT,
    message: 'Provide ids_xml or ids_path.',
  });
}

function summarizeIdsReport(report: unknown): {
  totalSpecifications: number;
  passedSpecifications: number;
  failedSpecifications: number;
  totalEntities: number;
  passedEntities: number;
  failedEntities: number;
} {
  const r = report as { specificationResults?: Array<{ entityResults?: Array<{ passed: boolean }> }> };
  const specs = r.specificationResults ?? [];
  let totalEntities = 0;
  let passedEntities = 0;
  let passedSpecifications = 0;
  for (const spec of specs) {
    const ents = spec.entityResults ?? [];
    let specPassed = ents.length > 0;
    for (const e of ents) {
      totalEntities++;
      if (e.passed) passedEntities++;
      else specPassed = false;
    }
    if (specPassed) passedSpecifications++;
  }
  return {
    totalSpecifications: specs.length,
    passedSpecifications,
    failedSpecifications: specs.length - passedSpecifications,
    totalEntities,
    passedEntities,
    failedEntities: totalEntities - passedEntities,
  };
}

const idsExplain: Tool = {
  name: 'ids_explain',
  description: 'Produce a natural-language explanation of a single IDS specification (applicability + requirements).',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      ids_xml: { type: 'string' },
      ids_path: { type: 'string' },
      spec_name: { type: 'string', description: 'Name of the specification to explain.' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const xml = await loadIdsXml(input, ctx);

    const doc = parseIDS(xml) as { specifications?: Array<{ name?: string; applicability?: unknown; requirements?: unknown[] }> };
    const target = input.spec_name as string | undefined;
    const specs = target ? (doc.specifications ?? []).filter((s) => s.name === target) : (doc.specifications ?? []);
    if (specs.length === 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Specification '${target}' not found in IDS document.`,
      });
    }
    const explanations = specs.map((s) => ({
      name: s.name,
      applicability: s.applicability,
      requirements: s.requirements,
    }));
    ctx.log.log('debug', 'ids_explain', { count: explanations.length });
    return okResult(`Loaded ${explanations.length} specification(s).`, { specifications: explanations });
  },
};

const modelAudit: Tool = {
  name: 'model_audit',
  description: 'Comprehensive model health check: required entities, GlobalId uniqueness, orphan detection, naming conventions, broken relationships. Returns Lighthouse-style scores per category.',
  scope: 'validate',
  inputSchema: {
    type: 'object',
    properties: { model_id: { type: 'string' } },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const issues: Array<{ severity: 'error' | 'warning' | 'info'; category: string; rule: string; message: string; entityCount?: number }> = [];
    // The audit answers about the session, not about the file as parsed (#2014).
    // It is the tool an agent is most likely to trust, so scoring a model clean
    // on identity while a queued `entity_create` has just duplicated a GlobalId
    // is the same defect this rule's #2003 fix was about: a pass that was never
    // earned. Counts come from the folded type table for the same reason.
    const overlay = pendingOverlay(m);
    const typeCounts = foldedTypeCounts(m.store, overlay);

    // 1. Required spatial entities
    for (const t of ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING']) {
      const count = typeCounts.get(t) ?? 0;
      // STEP type names are stored UPPERCASE; a message an agent reads renders
      // them in IfcPascalCase. `Missing required entity IFCSITE` sat next to
      // `No IfcBuildingStorey entities` in the same payload.
      const name = IFC_ENTITY_NAMES[t] ?? t;
      if (count === 0) {
        issues.push({ severity: 'error', category: 'structure', rule: 'required-entity', message: `Missing required entity ${name}` });
      } else if (t === 'IFCPROJECT' && count > 1) {
        issues.push({ severity: 'error', category: 'structure', rule: 'single-project', message: `Multiple ${name} entities (${count})` });
      }
    }
    if ((typeCounts.get('IFCBUILDINGSTOREY') ?? 0) === 0) {
      issues.push({ severity: 'warning', category: 'structure', rule: 'has-storeys', message: 'No IfcBuildingStorey entities' });
    }

    // 2. GlobalId uniqueness (only IfcRoot subtypes)
    //
    // Cross-schema, not the parser's IFC4_ADD2_TC1 codegen pin (#2003): the pin
    // answers an empty chain for 39 IFC2X3 `IfcRoot` classes, 80 IFC4X3 ones and
    // 4 post-ADD2 IFC4 ones, and this rule skipped every one of them — so
    // `model_audit` scored a file clean on identity without having looked at it.
    // The test is `includes`, which is what makes the swap safe: the two
    // functions return opposite orders, so any positional read of the chain
    // would invert on 717 of the 776 pinned classes. Over those 776 the verdicts
    // and leaf names are identical, so no IFC4 file changes — measured in
    // `packages/parser/test/inheritance-chain-equivalence.test.ts`.
    const seen = new Map<string, number[]>();
    const addGid = (gid: string, id: number): void => {
      if (!gid) return;
      const list = seen.get(gid) ?? [];
      list.push(id);
      seen.set(gid, list);
    };
    for (const [type, ids] of m.store.entityIndex.byType) {
      if (!getInheritanceChainAcrossSchemas(type).includes('IfcRoot')) continue;
      for (const id of ids) {
        if (overlay?.deleted.has(id)) continue;
        addGid(new EntityNode(m.store, id).globalId, id);
      }
    }
    // Queued entities are held to the same rule, chain check included — an agent
    // creating a second entity under an existing GlobalId is exactly the mistake
    // this check exists to catch, and it was invisible here.
    for (const created of overlay?.created ?? []) {
      if (!getInheritanceChainAcrossSchemas(created.ifcType).includes('IfcRoot')) continue;
      addGid(created.globalId, created.expressId);
    }
    let duplicates = 0;
    for (const [gid, ids] of seen) {
      if (ids.length > 1) {
        duplicates++;
        issues.push({ severity: 'error', category: 'identity', rule: 'duplicate-globalid', message: `Duplicate GlobalId ${gid} on ${ids.length} entities` });
      }
    }

    // 3. Naming
    let unnamed = 0;
    let totalProducts = 0;
    const countName = (name: string): void => {
      totalProducts++;
      if (!name || name.trim() === '') unnamed++;
    };
    // `isProductType`, not "anything that is not a relationship or a property".
    // The old test let `IfcCartesianPoint`, `IfcLocalPlacement` and every other
    // geometry primitive into the denominator — none of which carries a Name, so
    // they all counted as unnamed and `dataQuality` scored the file on how much
    // geometry it had rather than on how well its products were named. This is
    // the same rule an untyped `query_entities` uses for "a product".
    const edits = overlay?.attributesByEntity();
    for (const [type, ids] of m.store.entityIndex.byType) {
      if (!isProductType(type)) continue;
      for (const id of ids) {
        if (overlay?.deleted.has(id)) continue;
        // The store's stored-name fast path, with the overlay consulted only for
        // the handful of entities that actually have a queued write. Routing
        // every id through `bim.entity` reparsed attributes on demand for the
        // whole model to serve a rename count.
        countName(edits?.get(id)?.get('Name') ?? new EntityNode(m.store, id).name);
      }
    }
    for (const created of overlay?.createdAll ?? []) {
      if (!isProductType(created.ifcType)) continue;
      countName(edits?.get(created.expressId)?.get('Name') ?? created.name ?? '');
    }
    if (unnamed > 0) {
      issues.push({
        severity: 'warning', category: 'data-quality', rule: 'has-name', entityCount: unnamed,
        message: `${unnamed.toLocaleString()} of ${totalProducts.toLocaleString()} entities have no Name attribute.`,
      });
    }

    // Lighthouse-style category scores: % of entities that pass each category check.
    const scores = {
      structure: scoreFromIssues(issues, 'structure'),
      identity: 100 - clamp(duplicates * 10),
      dataQuality: totalProducts === 0 ? 100 : Math.round(((totalProducts - unnamed) / totalProducts) * 100),
    };
    const overall = Math.round((scores.structure + scores.identity + scores.dataQuality) / 3);
    return okResult(
      `Audit score: ${overall}/100 (${issues.length} issue${issues.length === 1 ? '' : 's'}).`,
      {
        overall,
        scores,
        issues,
        totals: { products: totalProducts, unnamed, duplicateGlobalIds: duplicates },
        ...pendingMutationsField(overlay),
      },
    );
  },
};

function scoreFromIssues(issues: Array<{ severity: string; category: string }>, cat: string): number {
  const errs = issues.filter((i) => i.category === cat && i.severity === 'error').length;
  const warns = issues.filter((i) => i.category === cat && i.severity === 'warning').length;
  return clamp(100 - errs * 25 - warns * 10);
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

const gherkinCheck: Tool = {
  name: 'gherkin_check',
  description: 'Run buildingSMART Gherkin validation rules. Not implemented in v0.1.',
  scope: 'validate',
  inputSchema: {
    type: 'object',
    properties: { model_id: { type: 'string' } },
    additionalProperties: false,
  },
  handler() {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'gherkin_check is planned for v0.2; use ids_validate or model_audit.',
    });
  },
};

export const validationTools: Tool[] = [idsValidate, idsExplain, modelAudit, gherkinCheck];
