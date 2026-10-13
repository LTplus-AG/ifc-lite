/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readNativeReview, readPortableReview, FINDING_SOURCE_KINDS } from '@ifc-lite/sdk/review';
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
  description: 'Read captured IDS/information Review facts, or supplied SavedAnalysisRun and SavedValidationReport historical evidence. Supplied imports never attest native execution. Source/identity binding and scope filtering cover complete target sets; unsupported inputs remain explicit.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    sources: { type: 'array', items: { type: 'string', enum: [...FINDING_SOURCE_KINDS] }, maxItems: 5 },
    model_ids: { type: 'array', items: { type: 'string' }, maxItems: 64 },
    max_findings: { type: 'integer', minimum: 0, maximum: 512, default: 128 },
    saved_analysis_runs: { type: 'array', items: { type: 'object' } },
    saved_validation_reports: { type: 'array', items: { type: 'object' } },
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
    const supplied = input.saved_analysis_runs !== undefined || input.saved_validation_reports !== undefined;
    const snapshot = supplied
      ? await readPortableReview(reviewCaptures(ctx), access.models, { sources: selected, modelIds: requested, maxFindings: cap,
        savedAnalysisRuns: input.saved_analysis_runs, savedValidationReports: input.saved_validation_reports }, access.allowed)
      : await readNativeReview(reviewCaptures(ctx), access.models,
        { sources: selected, modelIds: requested, maxFindings: cap }, access.allowed);
    const omitted = snapshot.bounds.omittedFindings;
    const summary = [`Review: ${snapshot.findings.length} ${supplied ? 'supplied historical' : 'native'} finding row(s) returned.`,
      omitted === null ? 'Retained row omission count unknown.' : `${omitted} retained row(s) omitted.`];
    if (supplied) summary.push('Imported evidence is historical and does not attest execution.');
    if ('retention' in snapshot && snapshot.retention?.inventoryOmitted) summary.push('Historical inventory omitted; count unknown.');
    if (!snapshot.bounds.nativeCoverageComplete) summary.push('Native coverage incomplete.');
    return okResult(summary.join(' '), snapshot);
  },
}];
