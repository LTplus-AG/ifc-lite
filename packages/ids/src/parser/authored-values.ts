/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which specification names and IDS titles `parseIDS` read from the XML.
 *
 * The parser fills a missing `@name` with `Specification <n>` and a missing
 * `<title>` with `Untitled IDS`, and the audit reads those texts as missing.
 * An author may write the same texts (both are `xs:string` in the XSD), so
 * the parser records the value it read from XML for each object. The audit
 * only treats the current value as authored if it matches that record (#10542).
 *
 * The record lives beside the document rather than in it, so `parseIDS`
 * returns the same objects as before. A document built in code, or a copy
 * of a parsed one, is not in the record and is read as before.
 */

import type { IDSInfo, IDSSpecification } from '../types.js';

const authoredNames = new WeakMap<IDSSpecification, string>();
const authoredTitles = new WeakMap<IDSInfo, string>();

/** Record that the parser read `spec.name` from a non-empty `@name`. */
export function markNameAuthored(spec: IDSSpecification): void {
  authoredNames.set(spec, spec.name);
}

/** Whether the current name matches the one read from XML. */
export function isNameAuthored(spec: IDSSpecification): boolean {
  return authoredNames.get(spec) === spec.name;
}

/** Record that the parser read `info.title` from a non-empty `<title>`. */
export function markTitleAuthored(info: IDSInfo): void {
  authoredTitles.set(info, info.title);
}

/** Whether the current title matches the one read from XML. */
export function isTitleAuthored(info: IDSInfo): boolean {
  return authoredTitles.get(info) === info.title;
}
