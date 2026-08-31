/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write-side guards for `markup.xsd` elements declared `minOccurs="1"` with
 * no schema default: `Topic/CreationDate`, `Comment/Date`,
 * `Topic/CreationAuthor`, `Topic/ModifiedAuthor` and `Comment/Author`.
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
 */
import { escapeXml } from './xml-text.js';

// BCF 3.0's markup.xsd types `Topic/@TopicType` and `Topic/@TopicStatus` as
// `NonEmptyOrBlankString`: after XML whitespace (#x9, #xA, #xD, #x20) is
// collapsed, the value must have length >= 1. A value that is present but
// consists entirely of XML whitespace collapses to nothing and is therefore
// as invalid as an absent one -- which is why the guards below reuse it, and
// why `writer.ts`'s own TopicType/TopicStatus checks import it too.
export const XML_WHITESPACE_ONLY = /^[\t\n\r ]*$/;

/** A required `xs:dateTime` on its way into an archive, escaped -- or an error. */
export function xsdDateTime(value: string | undefined, element: string, where: string): string {
  if (!value || XML_WHITESPACE_ONLY.test(value)) {
    throw new Error(
      `BCF requires ${element} (${where} has none). markup.xsd declares it ` +
        `minOccurs="1" with no default, and a time the source never stated is ` +
        `not the writer's to invent. Set it before writing.`
    );
  }
  return escapeXml(value);
}

/** A required plain-string element on its way into an archive, escaped -- or an error. */
export function xsdRequiredString(value: string | undefined, element: string, where: string): string {
  if (!value || XML_WHITESPACE_ONLY.test(value)) {
    throw new Error(
      `BCF requires ${element} (${where} has none). markup.xsd declares it ` +
        `minOccurs="1" with no default, and a value the source never stated is ` +
        `not the writer's to invent. Set it before writing.`
    );
  }
  return escapeXml(value);
}
