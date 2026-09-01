/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading text out of BCF's XML, and escaping it back in.
 *
 * Split out of `reader.ts` so the component parsers can share it without a
 * cycle. `escapeXml` here is the inverse of `unescapeXml`, and the two are
 * pinned against each other in `writer.test.ts`.
 */

/**
 * Extract a simple element value from XML
 *
 * Values are unescaped so {@link escapeXml} round-trips correctly (see
 * escapeXml/unescapeXml regression: & < > " ' in titles/descriptions/
 * comments must come back exactly as written, not as literal entities).
 */
export function extractElement(content: string, elementName: string): string | undefined {
  const match = content.match(new RegExp(`<${elementName}>([^<]*)<\\/${elementName}>`));
  return match?.[1] !== undefined ? unescapeXml(match[1]) : undefined;
}

/**
 * Escape XML special characters
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The five entities {@link escapeXml} produces. */
const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

/**
 * Decode XML character references: the five named entities `escapeXml` writes,
 * and the numeric forms `&#38;` / `&#x26;` that other authoring tools emit.
 *
 * ONE pass, not a chain of `replace` calls. A chain has to decode `&amp;` last,
 * or a literal `&lt;` written as `&amp;lt;` is corrupted into `<` by the
 * earlier pass -- and adding numeric references to a chain reintroduces that
 * hazard from a second direction, since `&#38;lt;` decodes to `&lt;` and would
 * then be re-scanned. A single pass never looks at its own output, so the
 * ordering question does not arise at all.
 *
 * An unrecognised or out-of-range reference is returned untouched rather than
 * dropped: this reads other tools' archives, and losing a character is worse
 * than leaving one encoded.
 */
export function unescapeXml(str: string): string {
  return str.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES[name];
      const code = Number.parseInt(dec ?? hex ?? '', dec !== undefined ? 10 : 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}
