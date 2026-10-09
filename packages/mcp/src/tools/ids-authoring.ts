/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS authoring tools, batch 1 (IDS-118): `ids_audit`, `ids_lint`,
 * `ids_read`, `ids_apply_ops`, `ids_write`. The `ids_schema_*` lookups
 * live in `ids-schema.ts`.
 *
 * Stateless by design: a document travels as Studio JSON (`ids_read`
 * output) between calls, and node ids are derived from the content, so
 * reading the same XML twice gives the same ids.
 *
 * External agents get the grounding gate. `ids_apply_ops` is the only tool
 * that changes a document, and it goes through `applyOpsGated`: every op is
 * validated against the op JSON Schema and the batch is checked against the
 * IFC schema tables; a refused batch changes nothing and the refusal (code,
 * path, message, candidates) goes back to the caller. Because Studio JSON
 * can be edited by hand between calls, `ids_write` audits what it
 * serialises and refuses a document with audit errors.
 */

import { auditIDSDocument, IDSParseError } from '@ifc-lite/ids';
import {
  applyOpsGated,
  createGateContext,
  createLintContext,
  createSidecar,
  createStudioDocument,
  getOpJsonSchema,
  lintDocument,
  nodePath,
  parseStudioDocument,
  readStudioDocument,
  serializeSidecar,
  writeStudioDocument,
  type GateIssue,
  type LintSeverity,
  type StudioDocument,
} from '@ifc-lite/ids-authoring';
import { writeIdsXml } from '@ifc-lite/rules';
import type { JsonSchema } from '../protocol/index.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { ToolContext } from '../context.js';
import type { Tool } from './types.js';
import { okResult } from './util.js';
import { loadIdsXml } from './validation.js';

const XML_INPUT = {
  ids_xml: { type: 'string', description: 'Inline IDS XML.' },
  ids_path: { type: 'string', description: 'Path to an .ids file (subject to allowedPaths).' },
} as const;

const DOC_INPUT = {
  type: 'object',
  description: 'A Studio document as returned by ids_read or ids_apply_ops (`doc`).',
} as const;

function parseError(err: unknown): never {
  if (err instanceof IDSParseError) {
    throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: `IDS does not parse: ${err.message}`, hint: 'Run ids_audit for details.' });
  }
  throw err;
}

/** `doc` when given, else the IDS in `ids_xml` / `ids_path`, else `fallback` (or an error). */
async function loadDocument(input: Record<string, unknown>, ctx: ToolContext, fallback?: () => StudioDocument): Promise<StudioDocument> {
  if (input.doc !== undefined) {
    try {
      return parseStudioDocument(input.doc);
    } catch (err) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `doc is not a Studio document: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  if (fallback && input.ids_xml === undefined && input.ids_path === undefined) return fallback();
  const xml = await loadIdsXml(input, ctx);
  try {
    return readStudioDocument(xml);
  } catch (err) {
    return parseError(err);
  }
}

async function lintSummary(doc: StudioDocument, options: { rules?: string[]; severity?: Record<string, LintSeverity | 'off'> } = {}) {
  const result = lintDocument(doc, await createLintContext(), options);
  const diagnostics = result.diagnostics.map((d) => ({ ...d, path: nodePath(doc, d.nodeId) }));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return { counts, diagnostics, suppressed: result.suppressed.length };
}

function outline(doc: StudioDocument) {
  return doc.ids.specifications.map((spec, i) => ({
    id: doc.nodes.specs[i].id,
    name: spec.name,
    applicability: doc.nodes.specs[i].applicability.map((n, j) => ({ id: n.id, type: spec.applicability.facets[j].type })),
    requirements: doc.nodes.specs[i].requirements.map((n, j) => ({ id: n.id, type: spec.requirements[j].facet.type })),
  }));
}

const idsAudit: Tool = {
  name: 'ids_audit',
  description: 'Conformance audit of an IDS file: XML and XSD shape, IFC entity/property names, restriction coherence. Answers "is this a valid IDS 1.0 file?". No model needed.',
  scope: 'validate',
  inputSchema: { type: 'object', properties: { ...XML_INPUT }, additionalProperties: false },
  async handler(input, ctx) {
    const report = await auditIDSDocument(await loadIdsXml(input, ctx));
    const counts = { error: 0, warning: 0, info: 0 };
    for (const issue of report.issues) counts[issue.severity]++;
    return okResult(`IDS audit: ${report.status} (${counts.error} errors, ${counts.warning} warnings, ${counts.info} info).`, {
      status: report.status,
      counts,
      issues: report.issues,
    });
  },
};

const idsLint: Tool = {
  name: 'ids_lint',
  description:
    'Lint an IDS document with the IDSL rule catalogue: does it mean what the author intends? Each diagnostic names its node (`nodeId`, `path`) and may carry quick fixes: op batches you can pass to ids_apply_ops unchanged. Pass `doc` (from ids_read / ids_apply_ops) or the XML.',
  scope: 'validate',
  inputSchema: {
    type: 'object',
    properties: {
      doc: DOC_INPUT,
      ...XML_INPUT,
      rules: { type: 'array', items: { type: 'string' }, description: 'Only these rule codes, e.g. ["IDSL-PROP-001"].' },
      severity: { type: 'object', description: 'Per-rule severity override: {"IDSL-SPEC-008": "off"}. Values: error, warning, info, off.' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const doc = await loadDocument(input, ctx);
    const severity = input.severity as Record<string, LintSeverity | 'off'> | undefined;
    const summary = await lintSummary(doc, { rules: input.rules as string[] | undefined, severity });
    const { counts } = summary;
    return okResult(`IDS lint: ${counts.error} errors, ${counts.warning} warnings, ${counts.info} info.`, { docId: doc.docId, ...summary });
  },
};

const idsRead: Tool = {
  name: 'ids_read',
  description:
    'Read IDS XML into a Studio document (JSON with a stable UUID for every specification, facet and constraint). Pass the returned `doc` to ids_apply_ops, ids_lint and ids_write. Reading the same XML twice gives the same ids.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { ...XML_INPUT }, additionalProperties: false },
  async handler(input, ctx) {
    const doc = await loadDocument(input, ctx);
    return okResult(`Read "${doc.ids.info.title}": ${doc.ids.specifications.length} specification(s).`, { doc, outline: outline(doc) });
  },
};

function opsInputSchema(): JsonSchema {
  const ops = getOpJsonSchema();
  return {
    type: 'object',
    properties: {
      doc: DOC_INPUT,
      ...XML_INPUT,
      title: { type: 'string', description: 'Title of a new, empty document (when neither doc nor XML is given).' },
      ops: { type: 'array', minItems: 1, items: { oneOf: ops.oneOf }, description: 'Operations of IDS ops vocabulary v1, applied in order as one batch.' },
    },
    required: ['ops'],
    additionalProperties: false,
    $defs: ops.$defs,
  };
}

function refusalText(issues: readonly GateIssue[]): string {
  const lines = issues.slice(0, 5).map((i) => {
    const near = i.candidates.slice(0, 3).map((c) => c.value);
    return `- ${i.code} at ${i.path}: ${i.message}${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`;
  });
  const more = issues.length > 5 ? `\n- … ${issues.length - 5} more in structuredContent.details.issues` : '';
  return `The grounding gate refused the batch; nothing was applied.\n${lines.join('\n')}${more}`;
}

const idsApplyOps: Tool = {
  name: 'ids_apply_ops',
  description:
    'Change an IDS document by applying typed operations. Every op is validated and the batch is checked by the grounding gate against the IFC schema tables (entities, predefined types, attributes, property sets, properties, enumerations, data types). A refused batch changes nothing and returns each problem with a path and ranked candidates; fix the names and resend the whole batch. Starts from `doc`, from the XML, or from an empty document. Returns the new `doc` and its lint diagnostics.',
  scope: 'read',
  inputSchema: opsInputSchema(),
  async handler(input, ctx) {
    const doc = await loadDocument(input, ctx, () => createStudioDocument({ title: typeof input.title === 'string' ? input.title : '' }));
    const result = applyOpsGated(doc, input.ops, await createGateContext());
    if (!result.ok) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: refusalText(result.issues),
        details: { refused: true, issues: result.issues },
        hint: 'Use ids_schema_search / ids_schema_entity / ids_schema_pset to look names up.',
      });
    }
    const lint = await lintSummary(result.doc);
    return okResult(
      `Applied ${result.applied.length} op(s). Lint: ${lint.counts.error} errors, ${lint.counts.warning} warnings, ${lint.counts.info} info.`,
      { doc: result.doc, applied: result.applied.length, touched: result.touched, lint },
    );
  },
};

const idsWrite: Tool = {
  name: 'ids_write',
  description:
    'Serialise a Studio document to IDS 1.0 XML. The XML is read back to prove nothing was lost and audited; a document with audit errors is refused. Also returns the studio.json sidecar that keeps node ids next to the XML.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { doc: DOC_INPUT }, required: ['doc'], additionalProperties: false },
  async handler(input, ctx) {
    const doc = await loadDocument(input, ctx);
    const out = writeStudioDocument(doc, writeIdsXml);
    if (!out.ok) {
      throw new ToolExecutionError({
        code: ToolErrorCode.UNSUPPORTED_OPERATION,
        message: `Cannot write this document: ${out.message}`,
        details: { reason: out.reason, lost: out.lost ?? [] },
      });
    }
    const audit = await auditIDSDocument(out.xml);
    const errors = audit.issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `The document fails the IDS audit (${errors.length} error(s)); it was not written. First: ${errors[0].message}`,
        details: { issues: errors },
        hint: 'Change documents through ids_apply_ops, which grounds names before they enter the document.',
      });
    }
    return okResult(`Wrote "${doc.ids.info.title}" (${out.xml.length} characters).`, {
      xml: out.xml,
      sidecar: serializeSidecar(createSidecar(doc, out.xml)),
      audit: { status: audit.status, issues: audit.issues },
    });
  },
};

export const idsAuthoringTools: Tool[] = [idsAudit, idsLint, idsRead, idsApplyOps, idsWrite];
