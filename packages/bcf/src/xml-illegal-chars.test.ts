/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Text typed or pasted into a topic can hold characters XML 1.0 forbids (a
 * vertical tab from a Word paste, a backspace, a NUL). `escapeXml` used to pass
 * them through, so the archive's `markup.bcf` was not well-formed XML and
 * IfcOpenShell's reader and libxml2 both refused the whole file. The check is
 * libxml2 against the official buildingSMART XSDs (`__fixtures__/schemas`),
 * not our own reader, which would accept what it wrote.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { createBCFComment, createBCFProject, createBCFTopic } from './index.js';
import { writeBCF } from './writer.js';
import { escapeXml } from './xml-text.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const schema = (dir: string, file: string) => readFileSync(path.join(DIR, '__fixtures__', 'schemas', dir, file), 'utf8');

describe('characters XML 1.0 cannot carry', () => {
  it('escapeXml drops them and keeps tab, line feed, carriage return and astral characters', () => {
    expect(escapeXml('a\u0000b\u0008c\u000bd\u000ce\u001ff￾￿')).toBe('abcdef');
    expect(escapeXml('a\tb\nc\rd 😀')).toBe('a\tb\nc\rd 😀');
  });

  it('escapeXml drops unpaired surrogates and keeps paired ones', () => {
    expect(escapeXml('a\ud800b\udc00c')).toBe('abc');
    expect(escapeXml('x\ud83d')).toBe('x');
    expect(escapeXml('\ud83d\ude00')).toBe('\ud83d\ude00');
  });

  for (const [version, dir] of [['2.1', 'v2_1'], ['3.0', 'v3_0']] as const) {
    it(`BCF ${version}: a topic whose text holds a backspace and a vertical tab validates against markup.xsd`, async () => {
      const topic = createBCFTopic({
        title: 'Title\u0008 one', description: 'Desc\u000bription', author: 'au\u0001thor', topicType: 'Issue', topicStatus: 'Open',
        labels: ['la\u0002bel'],
      });
      topic.comments.push(createBCFComment({ author: 'a', comment: 'reply\u000c text' }));
      const project = createBCFProject({ name: 'P\u0007', version });
      project.projectId = 'pro\u000bject-\ud800id';
      project.topics.set(topic.guid, topic);
      const zip = await JSZip.loadAsync(await (await writeBCF(project)).arrayBuffer());
      const markup = await zip.file(`${topic.guid}/markup.bcf`)!.async('string');
      const result = await validateXML({
        xml: [{ fileName: 'subject.xml', contents: markup }],
        schema: [schema(dir, 'markup.xsd')],
        preload: version === '3.0' ? [{ fileName: 'shared-types.xsd', contents: schema(dir, 'shared-types.xsd') }] : [],
      });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      expect(result.valid).toBe(true);

      // project.bcfp carries the attribute path (ProjectId) and the Name element.
      const bcfp = await zip.file('project.bcfp')!.async('string');
      expect(bcfp).toContain('ProjectId="project-id"');
      const projectResult = await validateXML({
        xml: [{ fileName: 'subject.xml', contents: bcfp }],
        schema: [schema(dir, 'project.xsd')],
        preload: version === '3.0' ? [{ fileName: 'shared-types.xsd', contents: schema(dir, 'shared-types.xsd') }] : [],
      });
      expect(projectResult.errors.map((e) => e.message)).toEqual([]);
      expect(projectResult.valid).toBe(true);
    });
  }
});
