/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write-side guards for `markup.xsd` elements declared `minOccurs="1"` with
 * no schema default: `Topic/CreationDate`, `Comment/Date`,
 * `Topic/CreationAuthor`, `Topic/ModifiedAuthor` and `Comment/Author`. Also
 * the normalizer shared by every `xs:dateTime` element in `markup.xsd`,
 * required or not: `Topic/CreationDate`, `Topic/ModifiedDate`,
 * `Topic/DueDate`, `Comment/Date`, `Comment/ModifiedDate` and
 * `Header/File/Date`.
 *
 * Split out of `writer.ts`, which was pushing its module-size budget. Mirrors
 * `numeric.ts`'s split for the numeric xsd guards (`xsdDouble`/`xsdInt`).
 *
 * `reader.ts` no longer invents a value for these fields when a source
 * `.bcfzip` omits them (a wall-clock `CreationDate`, a placeholder `'Unknown'`
 * author) -- so a `BCFTopic`/`BCFComment` read back from a non-conformant
 * archive can arrive with any of them unset. Inventing one HERE, on write,
 * would be that same fabrication under a different name; dropping the element
 * entirely hands the caller an archive that already fails the schema. So both
 * refuse, the same way the `TopicType`/`TopicStatus` check in `writer.ts`
 * does for BCF 3.0.
 *
 * `xs:dateTime` is stricter than the callers ever validated: an HTML
 * `<input type="date">` yields a bare `YYYY-MM-DD`, which every one of the
 * elements above rejects as "not a valid value of the atomic type
 * xs:dateTime" (buildingSMART/BCF-XML `markup.xsd`, confirmed against a real
 * reported archive -- issue #3612's `markup.bcf` carried exactly this on
 * `DueDate`). `normalizeXsdDateTime` turns a bare date into midnight UTC,
 * passes an already-valid `xs:dateTime` through UNCHANGED (no reformatting,
 * no timezone shift), and returns `undefined` for anything else.
 */
import { escapeXml } from './xml-text.js';

// A full `xs:dateTime`: date, mandatory 'T', time, optional fractional
// seconds, optional timezone (Z or ±HH:MM). Deliberately permissive about
// what counts as "already valid" -- this only decides pass-through-unchanged
// vs normalize-or-reject, never reformats a value that already matches.
const XSD_DATETIME_RE = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
// A bare xs:date, e.g. what an HTML `<input type="date">` yields.
const BARE_DATE_RE = /^-?\d{4,}-\d{2}-\d{2}$/;

/**
 * Normalize a date-ish string to a valid `xs:dateTime`, or `undefined` if it
 * can't be made into one. A value already matching `xs:dateTime` is returned
 * trimmed but otherwise UNCHANGED -- never reformatted or shifted. A bare
 * `YYYY-MM-DD` becomes midnight UTC on that date. Anything else (an empty
 * string, free text, a malformed timestamp) is unparseable and comes back
 * `undefined`; the caller decides whether that means "omit the element" or
 * "refuse to write".
 */
export function normalizeXsdDateTime(value: string): string | undefined {
  const trimmed = value.trim();
  if (XSD_DATETIME_RE.test(trimmed)) return trimmed;
  if (BARE_DATE_RE.test(trimmed)) return `${trimmed}T00:00:00Z`;
  return undefined;
}

// BCF 3.0's markup.xsd types `Topic/@TopicType` and `Topic/@TopicStatus` as
// `NonEmptyOrBlankString`: after XML whitespace (#x9, #xA, #xD, #x20) is
// collapsed, the value must have length >= 1. A value that is present but
// consists entirely of XML whitespace collapses to nothing and is therefore
// as invalid as an absent one -- which is why the guards below reuse it, and
// why `writer.ts`'s own TopicType/TopicStatus checks import it too.
export const XML_WHITESPACE_ONLY = /^[\t\n\r ]*$/;

/**
 * A required `xs:dateTime` on its way into an archive: normalized (a bare
 * date becomes midnight UTC; an already-valid dateTime passes through
 * unchanged), escaped -- or an error. `minOccurs="1"` with no default means
 * there is no valid element to omit here, so an absent or unparseable value
 * both refuse rather than write something invalid or invented.
 */
export function xsdDateTime(value: string | undefined, element: string, where: string): string {
  if (!value || XML_WHITESPACE_ONLY.test(value)) {
    throw new Error(
      `BCF requires ${element} (${where} has none). markup.xsd declares it ` +
        `minOccurs="1" with no default, and a time the source never stated is ` +
        `not the writer's to invent. Set it before writing.`
    );
  }
  const normalized = normalizeXsdDateTime(value);
  if (normalized === undefined) {
    throw new Error(
      `BCF requires ${element} to be a valid xs:dateTime (${where} has ` +
        `"${value}", which is neither a dateTime nor a bare YYYY-MM-DD date). ` +
        `markup.xsd types it xs:dateTime with no default, so an unparseable ` +
        `value is not the writer's to invent a fallback for. Fix it before writing.`
    );
  }
  return escapeXml(normalized);
}

/**
 * An optional `xs:dateTime` on its way into an archive: normalized the same
 * way as `xsdDateTime`, but `undefined` (never a throw) for anything absent
 * or unparseable. `minOccurs="0"` makes omitting the element schema-valid,
 * and that is always preferable to writing invalid text that poisons the
 * whole file -- the caller checks the return value and skips the element
 * when it is `undefined`.
 */
export function xsdOptionalDateTime(value: string | undefined): string | undefined {
  if (!value || XML_WHITESPACE_ONLY.test(value)) return undefined;
  const normalized = normalizeXsdDateTime(value);
  return normalized === undefined ? undefined : escapeXml(normalized);
}

/**
 * A required author-like string on its way into an archive, escaped -- or an error.
 *
 * BCF 2.1 uses `UserIdType`, an unrestricted `xs:string`, so an explicitly
 * supplied empty or whitespace-only author is schema-valid. BCF 3.0 replaced
 * it with `NonEmptyOrBlankString`, whose collapsed value must be non-empty.
 * Absence is invalid in both versions because the element itself is required.
 */
export function xsdRequiredString(
  value: string | undefined,
  element: string,
  where: string,
  version: '2.1' | '3.0',
): string {
  if (value === undefined || (version === '3.0' && XML_WHITESPACE_ONLY.test(value))) {
    throw new Error(
      `BCF requires ${element} (${where} has none). markup.xsd declares it ` +
        `minOccurs="1" with no default, and a value the source never stated is ` +
        `not the writer's to invent. Set it before writing.`
    );
  }
  return escapeXml(value);
}
