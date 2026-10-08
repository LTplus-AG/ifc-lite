/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS authoring tools, batch 2 (IDS-119): `ids_diff`, plus the model-loop
 * and test-suite tools `ids_preview`, `ids_infer`, `ids_coverage` and
 * `ids_test`.
 *
 * `ids_diff` works today (re-identification matcher, `diffIds`). The other
 * four are declared with their final input schemas and answer
 * UNSUPPORTED_OPERATION, the same convention as `gherkin_check`: the
 * funnel, inference and coverage engines (IDS model loop) and the
 * test-suite runner (IDS-110) are not in this release. Each replaces its
 * stub handler when its engine lands; the names and inputs do not change.
 */

import { readFile } from 'node:fs/promises';
import { IDSParseError, parseIDS, type IDSDocument } from '@ifc-lite/ids';
import { diffIds } from '@ifc-lite/ids-authoring';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { ToolContext } from '../context.js';
import { resolveSafePath } from '../safe-path.js';
import type { Tool } from './types.js';
import { okResult } from './util.js';

async function loadSide(input: Record<string, unknown>, side: 'before' | 'after', ctx: ToolContext): Promise<IDSDocument> {
  const inline = input[`${side}_xml`];
  const path = input[`${side}_path`];
  let xml: string;
  if (typeof inline === 'string') xml = inline;
  else if (typeof path === 'string') xml = await readFile(await resolveSafePath(path, ctx, 'read'), 'utf-8');
  else throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `Provide ${side}_xml or ${side}_path.` });
  try {
    return parseIDS(xml);
  } catch (err) {
    if (!(err instanceof IDSParseError)) throw err;
    throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: `The ${side} IDS does not parse: ${err.message}` });
  }
}

const idsDiff: Tool = {
  name: 'ids_diff',
  description:
    'Semantic diff of two IDS revisions. Specifications and facets are paired by identifier, then name and applicability, then similarity, so a rename or an edited requirement is one change. Returns added / removed / changed entries with XML paths and a plain-language line each.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      before_xml: { type: 'string' },
      before_path: { type: 'string', description: 'Subject to allowedPaths.' },
      after_xml: { type: 'string' },
      after_path: { type: 'string', description: 'Subject to allowedPaths.' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const diff = diffIds(await loadSide(input, 'before', ctx), await loadSide(input, 'after', ctx));
    const head = diff.identical ? 'No changes.' : `${diff.entries.length} change(s):`;
    const lines = diff.entries.slice(0, 20).map((e) => `- ${e.text}`);
    return okResult([head, ...lines].join('\n'), { identical: diff.identical, entries: diff.entries });
  },
};

function notInThisRelease(name: string, engine: string): Tool['handler'] {
  return () => {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: `${name} is not available in this release: it needs ${engine}, which has not shipped yet.`,
      hint: 'Use ids_validate to check a model against an IDS, and ids_lint for static checks.',
    });
  };
}

const MODEL_ID = { type: 'string', description: 'Loaded model to evaluate against (default: the only one).' } as const;
const IDS_SOURCE = {
  ids_xml: { type: 'string' },
  ids_path: { type: 'string' },
  doc: { type: 'object', description: 'A Studio document from ids_read / ids_apply_ops.' },
} as const;
const MODEL_LOOP = 'the IDS model loop (funnel, inference and coverage engines)';

const idsPreview: Tool = {
  name: 'ids_preview',
  description: 'Funnel counts per specification against a loaded model: how many elements each applicability facet keeps, and how many pass each requirement. Not available yet.',
  scope: 'validate',
  inputSchema: { type: 'object', properties: { model_id: MODEL_ID, ...IDS_SOURCE, spec_id: { type: 'string' } }, additionalProperties: false },
  handler: notInThisRelease('ids_preview', MODEL_LOOP),
};

const idsInfer: Tool = {
  name: 'ids_infer',
  description: 'Infer specifications from the elements a selector picks in a loaded model (IfcOpenShell selector syntax). Returns ops for ids_apply_ops. Not available yet.',
  scope: 'validate',
  inputSchema: {
    type: 'object',
    properties: { model_id: MODEL_ID, select: { type: 'string' }, threshold: { type: 'number', minimum: 0, maximum: 1 } },
    required: ['select'],
    additionalProperties: false,
  },
  handler: notInThisRelease('ids_infer', MODEL_LOOP),
};

const idsCoverage: Tool = {
  name: 'ids_coverage',
  description: 'Element classes in a loaded model that no specification of the IDS governs. Not available yet.',
  scope: 'validate',
  inputSchema: { type: 'object', properties: { model_id: MODEL_ID, ...IDS_SOURCE }, additionalProperties: false },
  handler: notInThisRelease('ids_coverage', MODEL_LOOP),
};

const idsTest: Tool = {
  name: 'ids_test',
  description: 'Run the test suites stored in an .idsz bundle (fixtures that must pass or fail each specification). Not available yet.',
  scope: 'validate',
  inputSchema: { type: 'object', properties: { idsz_path: { type: 'string' } }, required: ['idsz_path'], additionalProperties: false },
  handler: notInThisRelease('ids_test', 'the IDS test-suite runner'),
};

export const idsAuthoringModelTools: Tool[] = [idsDiff, idsPreview, idsInfer, idsCoverage, idsTest];
