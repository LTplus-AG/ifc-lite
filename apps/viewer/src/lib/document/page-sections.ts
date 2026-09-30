/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit page breaks separate content sections (#6485). Leading, trailing and
 * consecutive breaks do not author empty pages. Other blocks, including blank
 * text and spacers, still count as authored content. Shared by preview and PDF
 * composition so half-width rows cannot pair across an explicit break.
 */
export function splitDocumentSections<T extends { kind: string }>(blocks: readonly T[]): T[][] {
  const sections: T[][] = [];
  let section: T[] = [];
  for (const block of blocks) {
    if (block.kind === 'page-break') {
      if (section.length > 0) { sections.push(section); section = []; }
    } else section.push(block);
  }
  if (section.length > 0) sections.push(section);
  return sections.length > 0 ? sections : [[]];
}
