/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which specification names and IDS titles `parseIDS` read from the XML.
 *
 * The parser fills a missing `@name` with `Specification <n>` and a missing
 * `<title>` with `Untitled IDS`, and the audit reads those texts as missing.
 * An author may write the same texts (both are `xs:string` in the XSD), so
 * the parser records here the objects whose value it read from the XML, and
 * the audit does not read an authored value as missing (#10542).
 *
 * The record lives beside the document rather than in it, so `parseIDS`
 * returns the same objects as before. A document built in code, or a copy
 * of a parsed one, is not in the record and is read as before.
 */

import type { IDSInfo, IDSSpecification } from '../types.js';

const authoredNames = new WeakSet<IDSSpecification>();
const authoredTitles = new WeakSet<IDSInfo>();

/** Record that the parser read `spec.name` from a non-empty `@name`. */
export function markNameAuthored(spec: IDSSpecification): void {
  authoredNames.add(spec);
}

/** Whether `parseIDS` read this specification's name from the XML. */
export function isNameAuthored(spec: IDSSpecification): boolean {
  return authoredNames.has(spec);
}

/** Record that the parser read `info.title` from a non-empty `<title>`. */
export function markTitleAuthored(info: IDSInfo): void {
  authoredTitles.add(info);
}

/** Whether `parseIDS` read this title from the XML. */
export function isTitleAuthored(info: IDSInfo): boolean {
  return authoredTitles.has(info);
}
