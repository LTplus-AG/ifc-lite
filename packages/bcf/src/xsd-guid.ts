/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Case normalisation for BCF `Guid` attributes.
 *
 * BCF 2.1's `markup.xsd`/`visinfo.xsd` accept a `Guid` of either hex case
 * (`[a-fA-F0-9]{8}-...`). BCF 3.0's `shared-types.xsd` narrows the `Guid` simple
 * type to LOWERCASE hex only (`[a-f0-9]{8}-...`). Real 2.1 producers emit
 * uppercase GUIDs, so a project read from one and written as 3.0 carried the
 * uppercase value through verbatim and failed validation on every `Topic`,
 * `Comment`, `Viewpoint`, `RelatedTopic` and `DocumentReference` guid.
 *
 * Hex case carries no information in a UUID, so lowercasing a value that IS a
 * UUID is lossless. A value that is not a UUID is returned untouched: this is
 * not the place to invent an identifier, and a caller that depends on an
 * opaque id round-tripping keeps it.
 */
const UUID_ANY_CASE = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

/** The guid as it must be written for `version`; every guid emitter shares this. */
export function bcfGuid(guid: string, version: '2.1' | '3.0'): string {
  return version === '3.0' && UUID_ANY_CASE.test(guid) ? guid.toLowerCase() : guid;
}
