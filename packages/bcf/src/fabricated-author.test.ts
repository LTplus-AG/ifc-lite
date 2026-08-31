/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `markup.xsd` declares `Topic/CreationAuthor` and `Comment/Author` as
 * required `UserIdType` (string) elements with no schema default (see
 * `__fixtures__/schemas/v2_1/markup.xsd` lines ~68, ~108), exactly like
 * `Topic/CreationDate` and `Comment/Date`, which `fabricated-creation-date.test.ts`
 * already pins. Before this fix, the reader tolerated an omitted Author by
 * substituting the literal string `'Unknown'` -- which looks exactly like a
 * genuinely-declared author to every downstream consumer (the "Created by"
 * label, the comment byline, and `writer.ts`, which re-serialized it into a
 * new `.bcfzip` as if the source had declared it), even though no tool ever
 * wrote it.
 *
 * Fix: leave the field undefined rather than fabricate a plausible-looking
 * placeholder, mirroring CreationDate/Date exactly.
 *
 * `Title` is a CONTROL assertion: it is populated from real, declared XML
 * content elsewhere in the same fixture, so it must still come through --
 * this isolates the CreationAuthor/Author defect rather than proving the
 * reader broadly works.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readBCF } from './reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = join(__dirname, '..', 'test-data');

/** Take the real PerspectiveCamera.bcf fixture and edit its markup.bcf, re-zip. */
async function archiveWithEditedMarkup(edit: (xml: string) => string): Promise<Uint8Array> {
  const original = await readFile(join(TEST_DATA_DIR, 'PerspectiveCamera.bcf'));
  const zip = await JSZip.loadAsync(original);
  const markupName = Object.keys(zip.files).find((n) => n.endsWith('markup.bcf'));
  if (!markupName) throw new Error('no markup.bcf in fixture');
  const xml = await zip.file(markupName)!.async('string');
  const edited = edit(xml);
  expect(edited, 'the edit must actually change the XML').not.toBe(xml);
  zip.file(markupName, edited);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('BCF reader — CreationAuthor/Author fabrication (markup.xsd required, no default)', () => {
  it('does not fabricate a placeholder CreationAuthor when the source omits the required element', async () => {
    const bytes = await archiveWithEditedMarkup((xml) =>
      xml.replace(/<CreationAuthor>[^<]*<\/CreationAuthor>/, ''),
    );

    const project = await readBCF(bytes);
    const topic = Array.from(project.topics.values())[0];
    expect(topic).toBeDefined();

    // CONTROL: Title is genuinely declared in the fixture and must still
    // come through -- isolates the defect to CreationAuthor, not a broken reader.
    expect(topic.title).toBe('Perspective Camera');

    // actual (pre-fix): the literal string 'Unknown', indistinguishable from
    // a genuinely-declared author of that name.
    // expected (post-fix): undefined, since the file never declared one.
    expect(topic.creationAuthor).not.toBe('Unknown');
    expect(topic.creationAuthor).toBeUndefined();
  });

  it('does not fabricate a placeholder Author when a Comment omits the required element', async () => {
    const bytes = await archiveWithEditedMarkup((xml) =>
      xml.replace(
        '</Topic>',
        '<Comment Guid="c1a2b3c4-0000-0000-0000-000000000002">' +
          '<Date>2026-01-01T00:00:00Z</Date>' +
          '<Comment>looks fine</Comment>' +
          '</Comment>' +
          '</Topic>',
      ),
    );

    const project = await readBCF(bytes);
    const topic = Array.from(project.topics.values())[0];
    expect(topic.comments).toHaveLength(1);
    const comment = topic.comments[0];

    // CONTROL: Comment text is genuinely declared and must still come through.
    expect(comment.comment).toBe('looks fine');

    expect(comment.author).not.toBe('Unknown');
    expect(comment.author).toBeUndefined();
  });
});
