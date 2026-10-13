/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BcfApiClient, type BcfCommentDto, type BcfTopicDto } from '@ifc-lite/bcf-api';
import { coreNetworkRequest } from '@ifc-lite/sandbox';
import { canonical, credentialFree, NATIVE_METADATA, record, refuse, text } from './bcf-publication-codec.js';
import type { NativeBcfPublicationCheck, NativeBcfPublicationCheckOptions, StoredBcfAttempt } from './bcf-publication-types.js';

/** Explicit bounded, read-only lookup through the canonical capability-gated transport. */
export async function lookupNativeBcfAttempt(attempt: StoredBcfAttempt, options: NativeBcfPublicationCheckOptions,
  secrets: readonly string[]): Promise<NativeBcfPublicationCheck> {
  const intent = attempt.intent;
  const sensitive = [...secrets, ...(options.token ? [options.token] : [])];
  credentialFree(intent, sensitive);
  const client = new BcfApiClient({ baseUrl: intent.baseUrl, version: intent.version, getAccessToken: () => options.token,
    fetchFn: async (url, init) => {
      if (init?.method && init.method !== 'GET') refuse('recovery only permits reads');
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
      const result = await coreNetworkRequest({ url, method: 'GET', headers, timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024,
        signal: options.signal }, options.networkGrants, options.networkTransport);
      if (result.truncated) refuse('server check exceeded response bound');
      return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
    } });
  const candidates: { guid: string }[] = [];
  const seen = new Set<string>();
  let incomparable = false;
  const now = new Date();
  function consider(item: BcfTopicDto | BcfCommentDto): void {
    if (!record(item) || !text(item.guid)) refuse('invalid server check response');
    // Servers may trim free text on storage. Such a match still only proposes
    // a manual candidate: discarding it could falsely release a duplicate write.
    const remote = item as unknown as Record<string, unknown>;
    if (!Object.entries(intent.payload).every(([key, value]) => {
      const stored = remote[key];
      if (['title', 'description', 'comment'].includes(key) && typeof stored === 'string' && typeof value === 'string') {
        return stored.trim() === value.trim();
      }
      return canonical(stored ?? null) === canonical(value ?? null);
    })) {
      // A server may rewrite or omit mutable fields. Without a client marker
      // or known remote GUID, a non-match cannot prove this is another effect.
      incomparable = true;
      return;
    }
    credentialFree({ guid: item.guid }, sensitive);
    if (!candidates.some(candidate => candidate.guid === item.guid)) candidates.push({ guid: item.guid });
    if (candidates.length > 50) refuse('too many matching recovery candidates');
  }
  if (intent.operation === 'createComment') {
    const comments = await client.getComments(intent.projectId, intent.topicGuid ?? '', { signal: options.signal });
    if (!Array.isArray(comments) || comments.length > 50_000) refuse('comment check exceeds work bound');
    for (const comment of comments) consider(comment);
  } else {
    let complete = false;
    // Bound requests as well as entities: a server-capped one-row page must
    // not turn the former 250-page budget into 50,000 network round trips.
    for (let skip = 0, pages = 0; skip <= 50_000 && pages <= 250; pages += 1) {
      const page = await client.getTopics(intent.projectId, { top: 200, skip }, { signal: options.signal });
      if (!Array.isArray(page) || page.length > 50_000) refuse('invalid topic page');
      // $top is a maximum: a server may cap it below 200. Only an empty page
      // proves exhaustion, and advancing by actual length avoids skipping rows.
      if (page.length === 0) { complete = true; break; }
      let fresh = 0;
      for (const topic of page) {
        if (!record(topic) || !text(topic.guid)) refuse('invalid server topic');
        if (seen.has(topic.guid)) continue;
        seen.add(topic.guid); fresh += 1; consider(topic);
      }
      if (seen.size > 50_000) refuse('topic check exceeds work bound');
      if (fresh === 0) refuse('server ignored topic pagination');
      skip += page.length;
    }
    // Partial enumeration cannot claim that an effect is absent.
    if (!complete) refuse('topic enumeration incomplete');
  }
  // An empty visible collection can hide a committed effect under another authority.
  // Token presence does not prove visibility; only the operator can assert this scope.
  const absenceConfirmed = !candidates.length && !incomparable && options.confirmFullReadAccess === true;
  return { at: now.toISOString(), result: candidates.length ? NATIVE_METADATA.check.ambiguous
    : absenceConfirmed ? NATIVE_METADATA.check.absent : NATIVE_METADATA.check.unavailable, candidates,
    ...(absenceConfirmed ? { fullReadAccessConfirmed: NATIVE_METADATA.fullReadAccessConfirmed } : {}) };
}
