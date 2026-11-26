/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isValidUuid } from '@ifc-lite/encoding';

/**
 * The guid as it must be written for `version`; every guid emitter shares this.
 * BCF 3.0's `shared-types.xsd` allows only lowercase hex, while 2.1 allows
 * either case, so 2.1 producers' uppercase guids failed 3.0 validation. Case
 * carries no information in a UUID, so lowercasing one is lossless; a value
 * that is not a UUID is returned untouched.
 */
export function bcfGuid(guid: string, version: '2.1' | '3.0'): string {
  return version === '3.0' && isValidUuid(guid) ? guid.toLowerCase() : guid;
}

/**
 * BCF 3.0 lowercases every guid, so two topics (or two comments, viewpoints or
 * document references of one topic) whose guids differ only by case would both
 * be written under one guid: the reader drops one topic ("Duplicate topic
 * Guid"), and a comment's `<Viewpoint Guid>` can no longer say which viewpoint
 * it means. Refuse rather than silently merge them (#11450). Items without a
 * guid are skipped. `what` names the items in the error, e.g. `topics` or
 * `viewpoints in topic "<guid>"`.
 */
function assertNoCaseOnlyGuidClash(
  items: Iterable<{ guid?: string }>,
  version: '2.1' | '3.0',
  what: string,
): void {
  if (version !== '3.0') return;
  const written = new Map<string, string>();
  for (const { guid } of items) {
    if (!guid) continue;
    const out = bcfGuid(guid, version);
    const clash = written.get(out);
    // An exact duplicate is not a case-only clash; lowercasing does not create it.
    if (clash !== undefined && clash !== guid) {
      throw new Error(
        `BCF ${version} guids are lowercase, so ${what} "${clash}" and "${guid}" ` +
          `would both be written as "${out}". Give one of them a different guid before writing.`
      );
    }
    written.set(out, guid);
  }
}

/** The writer's preflight: every topic, and each topic's comments, viewpoints and document references. */
export function assertNoCaseOnlyGuidClashes(
  topics: Iterable<{ guid: string; comments: { guid?: string }[]; viewpoints: { guid?: string }[]; documentReferences?: { guid?: string }[] }>,
  version: '2.1' | '3.0',
): void {
  const all = [...topics];
  assertNoCaseOnlyGuidClash(all, version, 'topics');
  for (const topic of all) {
    const inTopic = `in topic "${topic.guid}"`;
    assertNoCaseOnlyGuidClash(topic.comments, version, `comments ${inTopic}`);
    assertNoCaseOnlyGuidClash(topic.viewpoints, version, `viewpoints ${inTopic}`);
    assertNoCaseOnlyGuidClash(topic.documentReferences ?? [], version, `document references ${inTopic}`);
  }
}
