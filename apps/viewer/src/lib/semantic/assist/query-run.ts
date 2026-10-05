/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createSemanticProvider, sanitizeSource, type Resolution, type SparqlResults } from '@ifc-lite/semantic';
import type { FetchTransport } from '@ifc-lite/sandbox/network';
import { useSemanticSession } from '../session';
import { identityFromRow } from '../resolver-context';
import { resolveResource } from '../resolver';
import { liveEntities } from '../viewer';
import { lintSemanticQuery, type SemanticQueryProposal } from './query-proposal';
import type { EndpointGrant } from './endpoint-grant';
import { captureRevisionPin, type RevisionPin } from './revision-pin';

/** One reviewed execution: rows plus the resolution each row had against the model revision at that moment. */
export interface QueryRun {
  source: string; retrievedAt: string; pin: RevisionPin;
  result: { form: 'select'; value: SparqlResults; statuses: Array<Resolution['status']> } | { form: 'construct'; value: string; quadCount: number };
}

/** Runs only a lint-clean proposal, only with the grant the user already exercised. Never stores the result in the session. */
export async function runReviewedQuery(proposal: SemanticQueryProposal, grant: EndpointGrant, signal?: AbortSignal, transport?: FetchTransport): Promise<QueryRun> {
  const lint = lintSemanticQuery(proposal);
  if (!lint.ok) throw new Error(`The query did not pass review: ${lint.issues.join('; ')}`);
  const response = await createSemanticProvider(transport).read({ endpoint: grant.endpoint, host: grant.host, kind: lint.form, query: proposal.query,
    loopbackHttpOrigin: grant.loopbackHttpOrigin, relayProvider: grant.relayProvider, bearer: grant.bearer }, signal);
  const settings = useSemanticSession.getState();
  const pin = captureRevisionPin(settings.revisions);
  const base = { source: sanitizeSource(response.source), retrievedAt: response.retrievedAt, pin };
  if (response.kind === 'construct') return { ...base, result: { form: 'construct', value: response.value, quadCount: response.quadCount } };
  if (response.kind !== 'select') throw new Error('The endpoint did not return query results');
  const entities = liveEntities();
  const statuses = response.value.rows.map(row => {
    const identity = identityFromRow(row, proposal.mapping, settings);
    return identity ? resolveResource(identity, entities, settings.revisions).status : 'invalid' as const;
  });
  return { ...base, result: { form: 'select', value: response.value, statuses } };
}
