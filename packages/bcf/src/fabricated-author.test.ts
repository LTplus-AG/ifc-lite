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
import { validateXML } from 'xmllint-wasm';

import { readBCF } from './reader.js';
import { writeBCF } from './writer.js';
import type { BCFProject } from './types.js';

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

async function markupOf(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const name = Object.keys(zip.files).find((entry) => entry.endsWith('markup.bcf'));
  if (!name) throw new Error('no markup.bcf in archive');
  return zip.file(name)!.async('string');
}

async function validatesMarkup(version: '2.1' | '3.0', markup: string): Promise<boolean> {
  const schemaDir = version === '2.1' ? 'v2_1' : 'v3_0';
  const markupSchema = await readFile(join(__dirname, '__fixtures__', 'schemas', schemaDir, 'markup.xsd'), 'utf8');
  const preload = version === '3.0'
    ? [{
        fileName: 'shared-types.xsd',
        contents: await readFile(join(__dirname, '__fixtures__', 'schemas', schemaDir, 'shared-types.xsd'), 'utf8'),
      }]
    : [];
  const result = await validateXML({
    xml: [{ fileName: 'subject.xml', contents: markup }],
    schema: [markupSchema],
    preload,
  });
  return result.valid;
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

describe('BCF writer — version-aware required author strings (#3574)', () => {
  it('preserves whitespace-only 2.1 authors and emits markup valid under the 2.1 schema', async () => {
    const project = await readBCF(await readFile(join(TEST_DATA_DIR, 'PerspectiveCamera.bcf')));
    const topic = Array.from(project.topics.values())[0];
    topic.creationAuthor = ' \t\n ';
    topic.comments = [{
      guid: 'c1a2b3c4-0000-0000-0000-000000000003',
      date: '2026-01-01T00:00:00Z',
      author: '\t ',
      comment: 'A schema-valid blank 2.1 author is still explicitly present.',
    }];

    const markup = await markupOf(await writeBCF(project));
    expect(markup).toContain('<CreationAuthor> \t\n </CreationAuthor>');
    expect(markup).toContain('<Author>\t </Author>');
    expect(await validatesMarkup('2.1', markup)).toBe(true);
  });

  it('retains 3.0 NonEmptyOrBlankString rejection for whitespace-only authors', async () => {
    const topic = {
      guid: '11111111-1111-4111-8111-111111111111',
      title: '3.0 author guard',
      topicType: 'Issue',
      topicStatus: 'Open',
      creationDate: '2026-01-01T00:00:00Z',
      creationAuthor: ' \t ',
      comments: [],
      viewpoints: [],
    };
    const project: BCFProject = { version: '3.0', topics: new Map([[topic.guid, topic]]) };

    await expect(writeBCF(project)).rejects.toThrow(/Topic\/CreationAuthor/);
  });
});
