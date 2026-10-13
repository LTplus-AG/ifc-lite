/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readNativeReview, FINDING_SOURCE_KINDS } from '@ifc-lite/sdk/review';
import { modelAllowed } from '../auth/scope.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { reviewCaptures, reviewAccess } from './review-captures.js';
import type { Tool } from './types.js';
import { okResult } from './util.js';

function strings(value: unknown, maximum: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some(x => typeof x !== 'string' || x.length > 1_024)) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Review selectors must be bounded string arrays.' });
  }
  return value;
}

/** No mutation, analysis rerun, export, filesystem write or decision update. */
export const reviewFindingsTools: Tool[] = [{
  name: 'review_findings', scope: 'read',
  description: 'Read captured native Review findings and provenance. IDS/information validation is supported; other native sources are explicit unsupported host inputs. Scope filtering covers entire captured target sets, including run metadata.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    sources: { type: 'array', items: { type: 'string', enum: [...FINDING_SOURCE_KINDS] }, maxItems: 5 },
    model_ids: { type: 'array', items: { type: 'string' }, maxItems: 64 },
    max_findings: { type: 'integer', minimum: 0, maximum: 512, default: 128 },
  } },
  async handler(input, ctx) {
    const selected = strings(input.sources, 5) ?? [...FINDING_SOURCE_KINDS];
    if (selected.some(x => !FINDING_SOURCE_KINDS.some(kind => kind === x))) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Unknown Review source kind.' });
    }
    const requested = strings(input.model_ids, 64);
    const cap = input.max_findings ?? 128;
    if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0 || cap > 512) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'max_findings must be an integer from 0 to 512.' });
    }
    if (requested?.some(id => !modelAllowed(ctx.scope, id))) {
      throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: 'A requested Review model is outside the caller scope.' });
    }
    const access = reviewAccess(ctx, 'read');
    const snapshot = await readNativeReview(reviewCaptures(ctx), access.models,
      { sources: selected, modelIds: requested, maxFindings: cap }, access.allowed);
    const omitted = snapshot.bounds.omittedFindings;
    const summary = [`Review: ${snapshot.findings.length} native finding row(s) returned.`,
      omitted === null ? 'Retained row omission count unknown.' : `${omitted} retained row(s) omitted.`];
    if (snapshot.retention?.inventoryOmitted) summary.push('Historical inventory omitted; count unknown.');
    if (!snapshot.bounds.nativeCoverageComplete) summary.push('Native coverage incomplete.');
    return okResult(summary.join(' '), snapshot);
  },
}];
