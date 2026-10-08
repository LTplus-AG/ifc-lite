/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GATE-BSDD-001 (§5): a facet `@uri` that the bSDD index knows to be
 * unresolvable is refused; a deprecated (inactive) one is a non-blocking
 * warning. Unchecked URIs (offline, not yet checked) pass: the gate is
 * synchronous and never calls bSDD, and lint IDSL-BSDD-001 reports them
 * once URI health has run.
 */

import type { IDSFacet } from '@ifc-lite/ids';
import type { GateContext } from './context.js';
import type { GateCandidate, GateIssue } from './types.js';

export function checkBsddUri(facet: IDSFacet, ctx: GateContext): Pick<GateIssue, 'code' | 'message' | 'candidates' | 'value' | 'severity'>[] {
  const uri = 'uri' in facet ? facet.uri : undefined;
  const record = uri ? ctx.bsdd?.get(uri) : undefined;
  if (!uri || !record) return [];
  const candidates: GateCandidate[] = (record.replacedBy ?? []).map((value) => ({ value, score: 1, reason: 'replacement published by bSDD' }));
  if (record.state === 'notFound') return [{ code: 'GATE-BSDD-001', message: `bSDD does not know ${uri}`, candidates, value: uri }];
  if (record.state === 'inactive') {
    return [{ code: 'GATE-BSDD-001', message: `${uri} is inactive (deprecated) in bSDD`, candidates, value: uri, severity: 'warning' }];
  }
  return [];
}
