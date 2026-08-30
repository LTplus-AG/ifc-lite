/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `markup.xsd` declares `Topic/CreationDate` and `Comment/Date` as required
 * `xs:dateTime` elements with no schema default (see
 * `__fixtures__/schemas/v3_0/markup.xsd` lines ~73-74), so a `.bcfzip` that
 * omits one is non-conformant. Before this fix, the reader tolerated the
 * omission by substituting `new Date().toISOString()` — the wall-clock time
 * *at read time* — which looks exactly like a genuinely-declared timestamp
 * to every downstream consumer (topic/comment chronological sort, the
 * `BCFTopicDetail` "Created on" label, and `writer.ts`, which re-serializes
 * it verbatim into a new `.bcfzip` as if it had been in the source file).
 * Because the substitute changes on every read of the same file, it isn't
 * even self-consistent — two reads of one untouched archive would disagree
 * with each other, which is worse than merely disagreeing with the format.
 *
 * Fix: leave the field undefined rather than fabricate a plausible-looking
 * timestamp, mirroring how a missing required `Guid` is already handled
 * (the topic-less case) rather than papering over it.
 *
 * `Title` includes a CONTROL assertion: it is population from real,
 * declared XML content elsewhere in the same fixture, so it must still come
 * through correctly — this isolates the CreationDate/Date defect rather
 * than proving the reader broadly works.
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

describe('BCF reader — CreationDate/Date fabrication (#markup.xsd required, no default)', () => {
  it('does not fabricate a wall-clock CreationDate when the source omits the required element', async () => {
    const bytes = await archiveWithEditedMarkup((xml) =>
      xml.replace(/<CreationDate>[^<]*<\/CreationDate>/, ''),
    );

    const before = Date.now();
    const project = await readBCF(bytes);
    const after = Date.now();

    const topic = Array.from(project.topics.values())[0];
    expect(topic).toBeDefined();

    // CONTROL: Title is genuinely declared in the fixture and must still
    // come through — isolates the defect to CreationDate, not a broken reader.
    expect(topic.title).toBe('Perspective Camera');

    // actual (pre-fix): a fresh `new Date().toISOString()` timestamp,
    // falling inside [before, after] — indistinguishable from a real value.
    // expected (post-fix): undefined, since the file never declared one.
    if (topic.creationDate !== undefined) {
      const parsed = Date.parse(topic.creationDate);
      const isFabricatedNow = !Number.isNaN(parsed) && parsed >= before && parsed <= after;
      expect(
        isFabricatedNow,
        `actual: creationDate="${topic.creationDate}" (fabricated at read time); expected: undefined`,
      ).toBe(false);
    }
    expect(topic.creationDate).toBeUndefined();
  });

  it('does not fabricate a wall-clock Date when a Comment omits the required element', async () => {
    const bytes = await archiveWithEditedMarkup((xml) =>
      xml.replace(
        '</Topic>',
        '<Comment Guid="c1a2b3c4-0000-0000-0000-000000000001">' +
          '<Author>reviewer@example.com</Author>' +
          '<Comment>looks fine</Comment>' +
          '</Comment>' +
          '</Topic>',
      ),
    );

    const before = Date.now();
    const project = await readBCF(bytes);
    const after = Date.now();

    const topic = Array.from(project.topics.values())[0];
    expect(topic.comments).toHaveLength(1);
    const comment = topic.comments[0];

    // CONTROL: Author is genuinely declared and must still come through.
    expect(comment.author).toBe('reviewer@example.com');

    if (comment.date !== undefined) {
      const parsed = Date.parse(comment.date);
      const isFabricatedNow = !Number.isNaN(parsed) && parsed >= before && parsed <= after;
      expect(
        isFabricatedNow,
        `actual: date="${comment.date}" (fabricated at read time); expected: undefined`,
      ).toBe(false);
    }
    expect(comment.date).toBeUndefined();
  });
});
