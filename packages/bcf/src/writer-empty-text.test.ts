/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF 3.0's markup.xsd types `Comment/Comment` and `Labels/Label` as
 * NonEmptyOrBlankString (minLength 1 after whitespace collapse) while keeping
 * both `minOccurs="0"`. The writer emitted `<Comment></Comment>` and
 * `<Label></Label>` for empty text, which fails the official schema. BCF 2.1
 * types them as plain xs:string (Comment required), so empty stays valid there.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (v: string, f: string) =>
  readFileSync(path.join(DIR, '__fixtures__', 'schemas', v, f), 'utf8');

const TOPIC = '11111111-1111-4111-8111-111111111111';
const VP = '55555555-5555-4555-8555-555555555555';

function project(version: '2.1' | '3.0', text: string, labels: string[]): BCFProject {
  return {
    version,
    projectId: '66666666-6666-4666-8666-666666666666',
    topics: new Map([
      [
        TOPIC,
        {
          guid: TOPIC,
          title: 'T',
          topicType: 'Issue',
          topicStatus: 'Open',
          creationDate: '2026-01-02T03:04:05Z',
          creationAuthor: 'a@example.invalid',
          labels,
          comments: [
            {
              guid: '44444444-4444-4444-8444-444444444444',
              date: '2026-01-05T06:07:08Z',
              author: 'a@example.invalid',
              comment: text,
              viewpointGuid: VP,
            },
          ],
          viewpoints: [
            {
              guid: VP,
              perspectiveCamera: {
                cameraViewPoint: { x: 1, y: 2, z: 3 },
                cameraDirection: { x: 0, y: 0, z: -1 },
                cameraUpVector: { x: 0, y: 1, z: 0 },
                fieldOfView: 60,
                aspectRatio: 1.5,
              },
            },
          ],
        },
      ],
    ]),
  };
}

async function markupOf(p: BCFProject): Promise<{ xml: string; blob: Blob }> {
  const blob = await writeBCF(p);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const name = Object.keys(zip.files).find((n) => n.endsWith('markup.bcf'))!;
  return { xml: await zip.files[name].async('string'), blob };
}

async function errorsFor(version: '2.1' | '3.0', xml: string): Promise<string[]> {
  const v = version === '2.1' ? 'v2_1' : 'v3_0';
  const r = await validateXML({
    xml: [{ fileName: 'subject.xml', contents: xml }],
    schema: [read(v, 'markup.xsd')],
    preload: version === '3.0' ? [{ fileName: 'shared-types.xsd', contents: read(v, 'shared-types.xsd') }] : [],
  });
  return r.errors.map((e) => e.message);
}

describe('empty Comment text and Label against the official schemas (#11453)', () => {
  for (const blank of ['', ' \t\r\n ', ' \u000b ']) {
    const tag = JSON.stringify(blank);
    it(`3.0: a viewpoint-only comment (${tag}) and a blank label write a schema-valid markup`, async () => {
      const { xml } = await markupOf(project('3.0', blank, ['keep', blank]));
      expect(await errorsFor('3.0', xml)).toEqual([]);
      // the comment itself and its viewpoint reference survive
      expect(xml).toContain(`<Viewpoint Guid="${VP}"/>`);
      expect(xml).toContain('<Label>keep</Label>');
    });

    it(`3.0: the viewpoint-only comment (${tag}) still round-trips with its viewpoint`, async () => {
      const { blob } = await markupOf(project('3.0', blank, ['keep']));
      const back = await readBCF(blob);
      const c = back.topics.get(TOPIC)!.comments[0];
      expect(c.comment).toBe('');
      expect(c.viewpointGuid).toBe(VP);
    });
  }

  it('3.0: omits the Labels container when every label is blank', async () => {
    const { xml } = await markupOf(project('3.0', 'text', ['', ' ']));
    expect(xml).not.toContain('<Labels');
    expect(await errorsFor('3.0', xml)).toEqual([]);
  });

  it('3.0: non-empty text is unchanged', async () => {
    const { xml } = await markupOf(project('3.0', 'hello', ['\u00a0']));
    expect(xml).toContain('<Comment>hello</Comment>');
    expect(xml).toContain('<Label>\u00a0</Label>');
    expect(await errorsFor('3.0', xml)).toEqual([]);
  });

  it('3.0: keeps a comment with only author and date', async () => {
    const input = project('3.0', '', []);
    input.topics.get(TOPIC)!.comments[0].viewpointGuid = undefined;
    const { xml, blob } = await markupOf(input);
    expect(await errorsFor('3.0', xml)).toEqual([]);
    expect((await readBCF(blob)).topics.get(TOPIC)!.comments).toMatchObject([
      { comment: '', author: 'a@example.invalid', date: '2026-01-05T06:07:08Z' },
    ]);
  });

  it.each(['', '   '])('2.1: keeps the required Comment element containing %j', async (text) => {
    const { xml } = await markupOf(project('2.1', text, ['a', '', ' ']));
    expect(xml).toContain(`<Comment>${text}</Comment>`);
    expect(xml).toContain('<Labels></Labels>');
    expect(xml).toContain('<Labels> </Labels>');
    expect(await errorsFor('2.1', xml)).toEqual([]);
  });
});
