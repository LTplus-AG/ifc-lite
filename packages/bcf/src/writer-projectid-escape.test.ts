/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `writeProjectFile` interpolates `BCFProject.projectId` directly into
 * `project.bcfp`'s `<Project ProjectId="...">` attribute. Every other
 * free-text field the writer emits (Title, Description, Author, Comment,
 * AssignedTo, Labels, Stage, DocumentReference names, project.bcfp's own
 * `<Name>`, ...) goes through `escapeXml`; `projectId` was the one
 * exception, interpolated raw.
 *
 * `BCFProject.projectId` is untyped free text (`projectId?: string`), not a
 * generated UUID: `writeBCF` is a public export that accepts caller-supplied
 * projects directly, and `readBCF` populates it from an existing archive's
 * `project.bcfp` via a raw attribute-value capture, so a value containing an
 * XML metacharacter reaches the writer both from direct API use and from a
 * read-modify-write round trip. A `"` in the value breaks the attribute's own
 * quoting; a bare `&` or `<` makes the document non-well-formed outright --
 * either way, `project.bcfp` fails to parse in a strict external reader
 * (Solibri/BIMcollab/usBIM), a total interop failure for the whole `.bcfzip`.
 *
 * `unescapeXml` is applied on the read side to match: prior to this fix, the
 * reader captured `ProjectId="..."` raw (consistent with the writer never
 * escaping it), so escaping only the write side without the read side would
 * have introduced a NEW double-escaping bug on any read-modify-write archive
 * (`&` -> `&amp;` written, then re-read literally as `&amp;` and escaped again
 * into `&amp;amp;` on the next write).
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';

import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject } from './types.js';

/**
 * Well-formedness only, independent of schema conformance: `xmllint --format`
 * requires the input to parse as XML before it can reformat it, but does not
 * apply any XSD content-model rules. Schema conformance of `project.bcfp` is
 * `schema-validation.test.ts`'s and `interop-conformance.test.ts`'s job;
 * whether `ProjectId` was escaped correctly is this file's, and an unescaped
 * quote breaks parsing before any content model is reached.
 */
async function assertWellFormed(xml: string): Promise<void> {
  const { valid, errors } = await validateXML({
    xml: [{ fileName: 'subject.xml', contents: xml }],
    normalization: 'format',
  });
  expect(errors.map((e) => e.message), xml).toEqual([]);
  expect(valid, xml).toBe(true);
}

async function writeProjectBcfp(project: BCFProject): Promise<string> {
  const blob = await writeBCF(project);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entry = zip.file('project.bcfp');
  if (!entry) throw new Error('writeBCF did not produce project.bcfp');
  return entry.async('string');
}

const METACHARACTER_PROJECT_ID = 'proj "quoted" & <tag> 😀 Кириллица';

describe('BCF writer — project.bcfp ProjectId escaping', () => {
  it('escapes a ProjectId containing XML metacharacters into well-formed XML', async () => {
    const project: BCFProject = {
      version: '2.1',
      projectId: METACHARACTER_PROJECT_ID,
      name: 'plain name',
      topics: new Map(),
    };
    const xml = await writeProjectBcfp(project);
    await assertWellFormed(xml);

    // Round-trips exactly (not double-escaped, not mangled) via the real reader.
    const project2 = await readBCF(await (await writeBCF(project)).arrayBuffer());
    expect(project2.projectId).toBe(METACHARACTER_PROJECT_ID);
  });

  it('BCF 3.0: same ProjectId escaping under <ProjectInfo>', async () => {
    const project: BCFProject = {
      version: '3.0',
      projectId: METACHARACTER_PROJECT_ID,
      topics: new Map(),
    };
    const xml = await writeProjectBcfp(project);
    await assertWellFormed(xml);
  });

  it('CONTROL: a plain ProjectId (no metacharacters) still writes and round-trips', async () => {
    const project: BCFProject = {
      version: '2.1',
      projectId: '66666666-6666-4666-8666-666666666666',
      name: 'plain name',
      topics: new Map(),
    };
    const xml = await writeProjectBcfp(project);
    expect(xml).toContain('ProjectId="66666666-6666-4666-8666-666666666666"');
    await assertWellFormed(xml);

    const project2 = await readBCF(await (await writeBCF(project)).arrayBuffer());
    expect(project2.projectId).toBe('66666666-6666-4666-8666-666666666666');
  });
});
