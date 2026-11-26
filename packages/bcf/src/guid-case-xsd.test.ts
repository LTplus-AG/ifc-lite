/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF 3.0 narrows `Guid` to lowercase hex; 2.1 accepts either case. A project
 * read from a 2.1 archive written by a tool that uppercases its GUIDs must
 * still write a schema-valid 3.0 archive, with every cross-reference agreeing.
 * Regression tests for #11450.
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
const read = (v: string, f: string) => readFileSync(path.join(DIR, '__fixtures__', 'schemas', v, f), 'utf8');

const TOPIC = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const COMMENT = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const VIEWPOINT = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
const RELATED = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD';
const DOCREF = 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE';
const DOCGUID = '11111111-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

function project(version: '2.1' | '3.0'): BCFProject {
  return {
    version,
    projectId: 'FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF',
    topics: new Map([[TOPIC, {
      guid: TOPIC, title: 'Upper', topicType: 'Issue', topicStatus: 'Open',
      creationDate: '2026-01-02T03:04:05Z', creationAuthor: 'a@example.invalid',
      relatedTopics: [RELATED],
      documentReferences: [
        { guid: DOCREF, url: 'https://example.invalid/d.pdf' },
        { documentGuid: DOCGUID },
      ],
      comments: [{ guid: COMMENT, date: '2026-01-02T03:04:05Z', author: 'a@example.invalid', comment: 'c', viewpointGuid: VIEWPOINT }],
      viewpoints: [{
        guid: VIEWPOINT,
        perspectiveCamera: {
          cameraViewPoint: { x: 1, y: 2, z: 3 }, cameraDirection: { x: 0, y: 0, z: -1 },
          cameraUpVector: { x: 0, y: 1, z: 0 }, fieldOfView: 50, aspectRatio: 1.5,
        },
      }],
    }]]),
  };
}

async function validateAll(version: '2.1' | '3.0'): Promise<{ names: string[]; errors: string[]; zip: JSZip }> {
  const zip = await JSZip.loadAsync(await (await writeBCF(project(version))).arrayBuffer());
  const dir = version === '3.0' ? 'v3_0' : 'v2_1';
  const errors: string[] = [];
  const names: string[] = [];
  for (const [name, xsd] of [['markup.bcf', 'markup.xsd'], ['viewpoint.bcfv', 'visinfo.xsd']] as const) {
    const entry = Object.keys(zip.files).find((n) => n.endsWith(name));
    expect(entry, name).toBeDefined();
    names.push(entry!);
    const r = await validateXML({
      xml: [{ fileName: 'subject.xml', contents: await zip.files[entry!].async('string') }],
      schema: [read(dir, xsd)],
      preload: version === '3.0' ? [{ fileName: 'shared-types.xsd', contents: read(dir, 'shared-types.xsd') }] : [],
    });
    errors.push(...r.errors.map((e) => e.message));
  }
  return { names, errors, zip };
}

describe('uppercase GUIDs', () => {
  it('write a schema-valid BCF 3.0 archive, every guid lowercased', async () => {
    const { errors, names } = await validateAll('3.0');
    expect(errors).toEqual([]);
    for (const n of names) expect(n).toBe(n.toLowerCase());
  });

  it('keep their cross-references in agreement after lowercasing', async () => {
    const back = await readBCF(await writeBCF(project('3.0')));
    const topic = [...back.topics.values()][0];
    expect(topic.guid).toBe(TOPIC.toLowerCase());
    expect(topic.comments[0].viewpointGuid).toBe(VIEWPOINT.toLowerCase());
    expect(topic.viewpoints[0].guid).toBe(VIEWPOINT.toLowerCase());
    expect(topic.relatedTopics).toEqual([RELATED.toLowerCase()]);
    expect(topic.documentReferences?.map((d) => d.documentGuid).filter(Boolean)).toEqual([DOCGUID.toLowerCase()]);
  });

  it('are left exactly as given in BCF 2.1, whose schema accepts either case', async () => {
    const { errors, zip } = await validateAll('2.1');
    expect(errors).toEqual([]);
    expect(Object.keys(zip.files).some((n) => n.startsWith(`${TOPIC}/`))).toBe(true);
  });
});

describe('guids that differ only by case', () => {
  it('are refused by the 3.0 writer instead of silently merged', async () => {
    const p = project('3.0');
    const a = [...p.topics.values()][0];
    const lower = TOPIC.toLowerCase();
    p.topics.set(lower, { ...a, guid: lower });
    await expect(writeBCF(p)).rejects.toThrow(new RegExp(`${TOPIC}.*${lower}|${lower}.*${TOPIC}`));
  });

  it('are kept distinct by the 2.1 writer, whose schema is case-insensitive', async () => {
    const p = project('2.1');
    const a = [...p.topics.values()][0];
    const lower = TOPIC.toLowerCase();
    p.topics.set(lower, { ...a, guid: lower });
    const back = await readBCF(await writeBCF(p));
    expect(back.topics.size).toBe(2);
  });

  // A comment's <Viewpoint Guid> names one viewpoint. Two viewpoints whose guids
  // lowercase to the same value make that reference ambiguous in 3.0.
  function twoViewpointsByCase(version: '2.1' | '3.0'): BCFProject {
    const p = project(version);
    const topic = [...p.topics.values()][0];
    // A different camera, so a swapped payload shows in the round trip.
    const camera = topic.viewpoints[0].perspectiveCamera!;
    topic.viewpoints.push({ ...topic.viewpoints[0], guid: VIEWPOINT.toLowerCase(), perspectiveCamera: { ...camera, cameraViewPoint: { x: 7, y: 8, z: 9 } } });
    return p;
  }

  it('in one topic\'s viewpoints are refused by the 3.0 writer', async () => {
    const lower = VIEWPOINT.toLowerCase();
    await expect(writeBCF(twoViewpointsByCase('3.0'))).rejects.toThrow(
      new RegExp(`viewpoints in topic "${TOPIC}" "${VIEWPOINT}" and "${lower}"`),
    );
  });

  it('in one topic\'s viewpoints are kept distinct by the 2.1 writer, comment reference intact', async () => {
    const back = await readBCF(await writeBCF(twoViewpointsByCase('2.1')));
    const topic = [...back.topics.values()][0];
    const at = (guid: string) => topic.viewpoints.find((v) => v.guid === guid)?.perspectiveCamera?.cameraViewPoint;
    expect(at(VIEWPOINT)).toEqual({ x: 1, y: 2, z: 3 });
    expect(at(VIEWPOINT.toLowerCase())).toEqual({ x: 7, y: 8, z: 9 });
    expect(topic.comments[0].viewpointGuid).toBe(VIEWPOINT);
  });

  it('in one topic\'s comments or document references are refused by the 3.0 writer', async () => {
    const lowerComment = COMMENT.toLowerCase();
    const p = project('3.0');
    const topic = [...p.topics.values()][0];
    topic.comments.push({ ...topic.comments[0], guid: lowerComment });
    await expect(writeBCF(p)).rejects.toThrow(new RegExp(`comments in topic "${TOPIC}" "${COMMENT}" and "${lowerComment}"`));

    const q = project('3.0');
    const refs = [...q.topics.values()][0].documentReferences!;
    refs.push({ ...refs[0], guid: DOCREF.toLowerCase() });
    await expect(writeBCF(q)).rejects.toThrow(/document references in topic/);
  });

  it('in different topics\' viewpoints are not a clash', async () => {
    const p = project('3.0');
    const a = [...p.topics.values()][0];
    const other = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAB';
    p.topics.set(other, { ...a, guid: other, comments: [], viewpoints: [{ ...a.viewpoints[0], guid: VIEWPOINT.toLowerCase() }] });
    // Same lowercased viewpoint guid under two topics: each topic folder is its own namespace.
    const back = await readBCF(await writeBCF(p));
    expect(back.topics.size).toBe(2);
  });
});
