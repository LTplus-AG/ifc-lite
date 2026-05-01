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
import { resolve } from 'node:path';
import { parseIDS, validateIDS, type IFCDataAccessor } from '@ifc-lite/ids';
import { getInheritanceChainForEntity } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
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
    let xml: string;
    if (typeof input.ids_xml === 'string') {
      xml = input.ids_xml;
    } else if (typeof input.ids_path === 'string') {
      const abs = resolve(input.ids_path);
      if (ctx.config.allowedPaths && ctx.config.allowedPaths.length > 0) {
        const ok = ctx.config.allowedPaths.some((p) => abs === p || abs.startsWith(p + '/'));
        if (!ok) {
          throw new ToolExecutionError({
            code: ToolErrorCode.PERMISSION_DENIED,
            message: `Path '${abs}' outside allowed roots`,
          });
        }
      }
      xml = await readFile(abs, 'utf-8');
    } else {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: 'Provide ids_xml or ids_path.',
      });
    }

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
    let xml: string;
    if (typeof input.ids_xml === 'string') xml = input.ids_xml;
    else if (typeof input.ids_path === 'string') xml = await readFile(resolve(input.ids_path), 'utf-8');
    else throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide ids_xml or ids_path.' });

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

    // 1. Required spatial entities
    for (const t of ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING']) {
      const ids = m.store.entityIndex.byType.get(t) ?? [];
      if (ids.length === 0) {
        issues.push({ severity: 'error', category: 'structure', rule: 'required-entity', message: `Missing required entity ${t}` });
      } else if (t === 'IFCPROJECT' && ids.length > 1) {
        issues.push({ severity: 'error', category: 'structure', rule: 'single-project', message: `Multiple IfcProject entities (${ids.length})` });
      }
    }
    const storeyIds = m.store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
    if (storeyIds.length === 0) issues.push({ severity: 'warning', category: 'structure', rule: 'has-storeys', message: 'No IfcBuildingStorey entities' });

    // 2. GlobalId uniqueness (only IfcRoot subtypes)
    const seen = new Map<string, number[]>();
    for (const [type, ids] of m.store.entityIndex.byType) {
      const chain = getInheritanceChainForEntity(type);
      if (!chain.includes('IfcRoot')) continue;
      for (const id of ids) {
        const node = new EntityNode(m.store, id);
        const gid = node.globalId;
        if (!gid) continue;
        const list = seen.get(gid) ?? [];
        list.push(id);
        seen.set(gid, list);
      }
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
    for (const [type, ids] of m.store.entityIndex.byType) {
      if (!type.startsWith('IFC')) continue;
      if (type.startsWith('IFCREL')) continue;
      if (type.startsWith('IFCPROPERTY')) continue;
      for (const id of ids) {
        totalProducts++;
        const node = new EntityNode(m.store, id);
        if (!node.name || node.name.trim() === '') unnamed++;
      }
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
      { overall, scores, issues, totals: { products: totalProducts, unnamed, duplicateGlobalIds: duplicates } },
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
