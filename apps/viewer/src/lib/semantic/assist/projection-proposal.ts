/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConflictPolicy } from '../projection';
import { onlyKeys, parseEnvelope, record, text } from './proposal-common';

/** Which linked-record field to project onto which installation's element, through the native projection service. */
export interface ProposedProjection { resource: string; field: string; mapping?: string; policy: ConflictPolicy }
export interface SemanticProjectionProposal { version: 1; kind: 'semantic.projection'; title: string; rationale?: string; projections: ProposedProjection[] }

export function parseSemanticProjection(answer: string): SemanticProjectionProposal {
  const value = parseEnvelope(answer, 'semantic.projection', ['rationale', 'projections']);
  if (value.rationale !== undefined && !text(value.rationale, 1000)) throw new Error('The rationale must be text');
  if (!Array.isArray(value.projections) || !value.projections.length || value.projections.length > 200) throw new Error('A projection proposal needs 1 to 200 projections');
  const keys = new Set<string>();
  const projections = value.projections.map((item, index): ProposedProjection => {
    const at = `Projection ${index + 1}`;
    if (!record(item)) throw new Error(`${at} is not an object`);
    onlyKeys(item, ['resource', 'field', 'mapping', 'policy'], at);
    if (!text(item.resource, 2000)) throw new Error(`${at} must name the installation record id`);
    if (!text(item.field, 120)) throw new Error(`${at} must name the record field to project`);
    if (item.mapping !== undefined && !text(item.mapping, 120)) throw new Error(`${at} mapping must be a native mapping id`);
    const policy = item.policy ?? 'error';
    if (policy !== 'error' && policy !== 'skip' && policy !== 'overwrite') throw new Error(`${at} policy must be error, skip or overwrite`);
    const key = `${item.resource}\u0000${item.field}\u0000${item.mapping ?? ""}`;
    if (keys.has(key)) throw new Error(`${at} repeats an earlier projection`);
    keys.add(key);
    return { resource: item.resource, field: item.field, ...(item.mapping === undefined ? {} : { mapping: item.mapping as string }), policy };
  });
  return { version: 1, kind: 'semantic.projection', title: (value.title as string).trim(),
    ...(value.rationale === undefined ? {} : { rationale: value.rationale as string }), projections };
}
