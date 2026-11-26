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
 * BCF 3.0 lowercases every guid, so two topics (or two viewpoints of one topic)
 * whose guids differ only by case would both be written under one guid: the
 * reader drops one topic ("Duplicate topic Guid"), and a comment's
 * `<Viewpoint Guid>` can no longer say which viewpoint it means. Refuse rather
 * than silently merge them (#11450). `what` names the items in the error, e.g.
 * `topics` or `viewpoints in topic "<guid>"`.
 */
export function assertNoCaseOnlyGuidClash(
  items: Iterable<{ guid: string }>,
  version: '2.1' | '3.0',
  what: string,
): void {
  if (version !== '3.0') return;
  const written = new Map<string, string>();
  for (const item of items) {
    const out = bcfGuid(item.guid, version);
    const clash = written.get(out);
    // An exact duplicate is not a case-only clash; lowercasing does not create it.
    if (clash !== undefined && clash !== item.guid) {
      throw new Error(
        `BCF ${version} guids are lowercase, so ${what} "${clash}" and "${item.guid}" ` +
          `would both be written as "${out}". Give one of them a different guid before writing.`
      );
    }
    written.set(out, item.guid);
  }
}
