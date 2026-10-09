/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ids.load` / `ids.lint` / `ids.validate` (IDS-122): the no-code
 * pipeline "Load IDS → Lint → Validate model → BCF". `ids.validate`
 * emits one row per failing element with `title` and `description`
 * columns, so its table wires straight into `bcf.createTopic`'s `rows`.
 *
 * The IDS document travels between nodes as a Studio document (plain
 * JSON, content-derived node ids; `@ifc-lite/ids-authoring`), the same
 * shape the MCP tools exchange.
 */

import { validateIDS, type IDSValidationReport, type IFCDataAccessor } from '@ifc-lite/ids';
import { createLintContext, lintDocument, nodePath, parseStudioDocument, readStudioDocument, type StudioDocument } from '@ifc-lite/ids-authoring';
import type { Column, Row, Table } from '@ifc-lite/flow';
import { ANY_ITEM, ANY_LIST, SCALAR_ITEM, TABLE_ITEM, type Ctx, type FlowNodeDef } from './host.js';

const DIAGNOSTIC_COLUMNS: readonly Column[] = [
  { name: 'code', type: 'string' },
  { name: 'severity', type: 'string' },
  { name: 'path', type: 'string' },
  { name: 'specification', type: 'string' },
  { name: 'message', type: 'string' },
];

const FAILURE_COLUMNS: readonly Column[] = [
  { name: 'title', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'specification', type: 'string' },
  { name: 'globalId', type: 'identifier' },
  { name: 'ifcType', type: 'string' },
];

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

function studioDoc(v: unknown, node: string): StudioDocument {
  try {
    return parseStudioDocument(v);
  } catch (err) {
    throw new Error(`${node}: the "ids" input is not an IDS document from ids.load (${err instanceof Error ? err.message : String(err)})`, { cause: err });
  }
}

function specName(doc: StudioDocument, specId: string | undefined): string | null {
  const i = specId ? doc.nodes.specs.findIndex((s) => s.id === specId) : -1;
  return i >= 0 ? doc.ids.specifications[i].name : null;
}

/** One row per failing element, phrased for an issue tracker. */
export function failureRows(report: IDSValidationReport): Row[] {
  const rows: Row[] = [];
  for (const spec of report.specificationResults) {
    for (const entity of spec.entityResults) {
      if (entity.passed) continue;
      const reasons = entity.requirementResults
        .filter((r) => r.status === 'fail')
        .map((r) => r.failureReason ?? r.checkedDescription);
      const label = entity.entityName ? `${entity.entityType} "${entity.entityName}"` : entity.entityType;
      rows.push({
        title: `${spec.specification.name}: ${label}`,
        description: reasons.join('\n'),
        specification: spec.specification.name,
        globalId: entity.globalId ?? null,
        ifcType: entity.entityType,
      });
    }
  }
  return rows;
}

function accessorFor(ctx: Ctx): IFCDataAccessor {
  const accessor = ctx.host.idsAccessor?.();
  if (!accessor) throw new Error('ids.validate: this host cannot read model data for IDS validation');
  return accessor;
}

export const idsNodes: FlowNodeDef[] = [
  {
    type: 'ids.load',
    title: 'Load IDS',
    category: 'ids',
    doc: 'Reads IDS XML (the `xml` input, else the `xml` param) into an IDS document for `ids.lint` and `ids.validate`. Node ids depend only on the content.',
    inputs: [{ name: 'xml', type: SCALAR_ITEM, optional: true, doc: 'IDS XML text, e.g. from a file or HTTP node.' }],
    outputs: [
      { name: 'ids', type: ANY_ITEM },
      { name: 'title', type: SCALAR_ITEM },
      { name: 'specifications', type: SCALAR_ITEM },
    ],
    params: [{ name: 'xml', kind: 'string', default: '', doc: 'IDS XML, used when the input is not wired.' }],
    capabilities: [],
    run: (_ctx, i, p) => {
      const xml = typeof i.xml === 'string' && i.xml.trim() !== '' ? i.xml : String(p.xml ?? '');
      if (xml.trim() === '') throw new Error('ids.load: no IDS XML (wire the `xml` input or set the param)');
      const doc = readStudioDocument(xml);
      return { ids: doc, title: doc.ids.info.title, specifications: doc.ids.specifications.length };
    },
  },
  {
    type: 'ids.lint',
    title: 'Lint IDS',
    category: 'ids',
    doc: 'Runs the IDSL lint rules over an IDS document. `table` has one row per diagnostic (code, severity, XML path, specification, message); `errors` counts error-severity rows. With `failOn` set, the node fails when a diagnostic at or above that severity remains.',
    inputs: [{ name: 'ids', type: ANY_ITEM }],
    outputs: [
      { name: 'table', type: TABLE_ITEM },
      { name: 'diagnostics', type: ANY_LIST },
      { name: 'errors', type: SCALAR_ITEM },
    ],
    params: [
      { name: 'rules', kind: 'string', default: '', doc: 'Comma-separated rule codes to run; empty runs all.' },
      { name: 'failOn', kind: 'enum', options: ['never', 'error', 'warning', 'info'], default: 'never' },
    ],
    capabilities: [],
    run: async (_ctx, i, p) => {
      const doc = studioDoc(i.ids, 'ids.lint');
      const rules = String(p.rules ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const { diagnostics } = lintDocument(doc, await createLintContext(), rules.length ? { rules } : {});
      const rows: Row[] = diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        path: nodePath(doc, d.nodeId) ?? d.nodeId,
        specification: specName(doc, d.specId),
        message: d.message,
      }));
      const failOn = p.failOn as 'never' | keyof typeof SEVERITY_RANK;
      if (failOn !== 'never' && diagnostics.some((d) => SEVERITY_RANK[d.severity] <= SEVERITY_RANK[failOn])) {
        throw new Error(`ids.lint: ${diagnostics.length} diagnostic(s), at least one at or above "${failOn}"`);
      }
      const table: Table = { columns: DIAGNOSTIC_COLUMNS, rows, key: 'path' };
      return { table, diagnostics, errors: diagnostics.filter((d) => d.severity === 'error').length };
    },
  },
  {
    type: 'ids.validate',
    title: 'Validate Model (IDS)',
    category: 'ids',
    doc: 'Validates the active model against an IDS document. `failures` has one row per failing element with `title` and `description` columns, so it wires straight into `bcf.createTopic` rows; `report` is the full validation report.',
    inputs: [{ name: 'ids', type: ANY_ITEM }],
    outputs: [
      { name: 'failures', type: TABLE_ITEM },
      { name: 'report', type: ANY_ITEM },
      { name: 'failed', type: SCALAR_ITEM },
    ],
    params: [],
    capabilities: ['model.read'],
    reads: 'model',
    run: async (ctx, i) => {
      const doc = studioDoc(i.ids, 'ids.validate');
      const model = ctx.host.bim.model.active();
      const report = await validateIDS(doc.ids, accessorFor(ctx), {
        modelId: model?.id ?? ctx.host.defaultModelId ?? 'model',
        schemaVersion: model?.schemaVersion ?? '',
        entityCount: model?.entityCount ?? 0,
      });
      const rows = failureRows(report);
      ctx.log('info', `${report.summary.failedSpecifications}/${report.summary.totalSpecifications} specification(s) failed, ${rows.length} failing element(s)`);
      return { failures: { columns: FAILURE_COLUMNS, rows, key: 'globalId' } satisfies Table, report, failed: rows.length };
    },
  },
];
