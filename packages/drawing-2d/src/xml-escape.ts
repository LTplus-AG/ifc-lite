/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one XML text/attribute escaper shared by every SVG writer.
 *
 * Besides the five predefined entities it replaces every character XML 1.0
 * forbids (U+0000-U+001F except TAB/LF/CR, U+FFFE, U+FFFF and lone
 * surrogates) with U+FFFD, so one stray control character in an IFC string
 * cannot make the whole document ill-formed.
 */
const XML_FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const XML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

export function escapeXml(value: string): string {
  return String(value)
    .replace(XML_FORBIDDEN, '�')
    .replace(/[&<>"']/g, (c) => XML_ENTITIES[c]);
}

/** ` data-entity-id="N"` for a finite id, otherwise the empty string. */
export function entityIdAttr(id: number): string {
  return Number.isFinite(id) ? ` data-entity-id="${id}"` : '';
}

/**
 * The one place a number becomes SVG text. `NaN`/`Infinity` stringify
 * verbatim through `toFixed`, which a conforming renderer must reject, so
 * every coordinate/size/rotation routes through here (mirrors the DXF
 * writer's single `fmt()`). Non-finite becomes `0`: the document stays
 * parseable and the degenerate geometry collapses at the visible origin.
 */
export function svgNum(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}
