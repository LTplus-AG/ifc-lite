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
 * `Title` includes a CONTROL assertion: it is populated from real,
 * declared XML content elsewhere in the same fixture, so it must still come
 * through correctly — this isolates the CreationDate/Date defect rather
 * than proving the reader broadly works.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateXML } from 'xmllint-wasm';

import { readBCF } from './reader.js';
import { writeBCF } from './writer.js';

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

/**
 * `markup.xsd` requires `Topic/CreationDate` and `Comment/Date`
 * (`minOccurs="1"`, no default) in BOTH 2.1 (:67, :107) and 3.0 (:73, :155),
 * so a writer that simply mirrors the reader's omission produces a
 * `markup.bcf` no conforming BCF tool has to accept -- and hands it back as an
 * ordinary Blob, with nothing to tell the caller. `writer.ts` refuses that
 * write instead, the same way it already refuses a BCF 3.0 topic with no
 * `TopicType`: it will neither invent a timestamp the source never stated nor
 * emit an archive it knows fails the schema.
 */
describe('BCF writer — refuses a markup.bcf it knows fails markup.xsd', () => {
  const COMMENT_NO_DATE =
    '<Comment Guid="c1a2b3c4-0000-0000-0000-000000000001">' +
    '<Author>reviewer@example.com</Author>' +
    '<Comment>looks fine</Comment>' +
    '</Comment>';

  /** xmllint against the real v2_1/markup.xsd (the fixture's own version). */
  async function markupIsSchemaValid(markup: string): Promise<{ valid: boolean; errors: string }> {
    const xsd = await readFile(
      join(__dirname, '__fixtures__', 'schemas', 'v2_1', 'markup.xsd'),
      'utf8',
    );
    const result = await validateXML({
      xml: [{ fileName: 'subject.xml', contents: markup }],
      schema: [xsd],
    });
    return { valid: result.valid, errors: result.errors.map((e) => e.message).join(' | ') };
  }

  async function markupOf(blob: Blob): Promise<string> {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const name = Object.keys(zip.files).find((n) => n.endsWith('markup.bcf'))!;
    return zip.file(name)!.async('string');
  }

  it('CONTROL: the untouched fixture round-trips to markup that validates', async () => {
    // Same fixture, same code path, CreationDate left in place. Without this,
    // a writer that threw on every topic would pass the two tests below.
    const project = await readBCF(await readFile(join(TEST_DATA_DIR, 'PerspectiveCamera.bcf')));
    const markup = await markupOf(await writeBCF(project));
    expect(markup).toContain('<CreationDate>');
    const { valid, errors } = await markupIsSchemaValid(markup);
    expect(valid, `round-tripped markup.bcf failed markup.xsd: ${errors}`).toBe(true);
  });

  it('refuses to write a Topic whose CreationDate the source never declared', async () => {
    const project = await readBCF(
      await archiveWithEditedMarkup((xml) =>
        xml.replace(/<CreationDate>[^<]*<\/CreationDate>/, ''),
      ),
    );
    // The error has to name the element, or the caller cannot act on it.
    await expect(writeBCF(project)).rejects.toThrow(/Topic\/CreationDate/);
  });

  it('refuses to write a Comment whose Date the source never declared', async () => {
    const project = await readBCF(
      await archiveWithEditedMarkup((xml) => xml.replace('</Topic>', COMMENT_NO_DATE + '</Topic>')),
    );
    await expect(writeBCF(project)).rejects.toThrow(/Comment\/Date/);
  });

  it('what the refusal replaces: emitting the topic without CreationDate fails markup.xsd', async () => {
    // Pin the reason. This builds the exact markup a mirror-the-omission
    // writer produces -- the round trip above with the one element dropped --
    // and shows an independent authority (buildingSMART's own XSD, via
    // xmllint) rejecting it. If that ever validated, the throw above would be
    // pointless ceremony rather than a guard.
    const project = await readBCF(await readFile(join(TEST_DATA_DIR, 'PerspectiveCamera.bcf')));
    const good = await markupOf(await writeBCF(project));
    const withoutCreationDate = good.replace(/\n?\s*<CreationDate>[^<]*<\/CreationDate>/, '');
    expect(withoutCreationDate, 'the edit must actually drop the element').not.toBe(good);

    const { valid, errors } = await markupIsSchemaValid(withoutCreationDate);
    expect(valid).toBe(false);
    expect(errors).toMatch(/CreationDate/);
  });
});
