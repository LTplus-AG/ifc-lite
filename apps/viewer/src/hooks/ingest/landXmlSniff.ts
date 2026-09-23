/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Filename-only candidacy check. A `.xml` file is handed straight to the
 * authoritative Rust parser, which validates the root element and namespace
 * while streaming and refuses anything else with LXML006/LXML007.
 *
 * This module used to also export a content sniffer (`isLandXmlContent`, with
 * `decodeXmlHead`/`rootStartTag` helpers) built for #4937's "content sniffing
 * for generic .xml" item. The authoritative-parser design superseded it before
 * it ever gained a caller, and it sat dead for long enough to accumulate ten
 * tests that implied coverage of a path nothing took. Removed rather than left
 * as a just-in-case path.
 *
 * If content sniffing is wanted again, note what it costs: deciding from the
 * bytes means reading past an arbitrarily long but legal XML prolog, which is
 * the whole reason the streaming parser owns this today.
 */
export function isLandXmlFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.xml');
}
