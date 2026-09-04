/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `DocumentReference/@Guid` is OPTIONAL in BCF 2.1 and REQUIRED in BCF 3.0.
 *
 * 2.1's markup.xsd declares it `<xs:attribute name="Guid" type="Guid"/>` with
 * no `use`, i.e. optional; 3.0's `DocumentReferenceAttributes` declares the
 * same attribute `use="required"`. `BCFDocumentReference.guid` is optional to
 * match 2.1, and the writer omitted the attribute whenever it was unset — so
 * any 3.0 topic carrying a document reference without one produced a
 * `markup.bcf` that fails validation ("The attribute 'Guid' is required but
 * missing"), and `markup.bcf` IS the issue: a viewer that rejects it drops
 * the topic entirely (#3612).
 *
 * The remedy is to mint one rather than to refuse. A `DocumentReference`
 * guid names only itself — nothing else in the archive refers to it, unlike
 * `RelatedTopic/@Guid` or `Comment/Viewpoint/@Guid` — so a generated value
 * loses nothing, and it follows `writeProjectFile`'s existing
 * `project.projectId || generateUuid()`. Refusing, the policy used for
 * `AspectRatio` and `TopicType`, is wrong here: those assert something about
 * the view or the issue that only the caller knows, and refusing would fail
 * the whole export over a field 2.1 says is optional.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { isValidUuid } from '@ifc-lite/encoding';
import { writeBCF } from './writer.js';
import type { BCFDocumentReference, BCFProject } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function schema(version: '2.1' | '3.0', file: string): string {
  const dir = version === '2.1' ? 'v2_1' : 'v3_0';
  return readFileSync(path.join(DIR, '__fixtures__', 'schemas', dir, file), 'utf8');
}

function projectWith(
  version: '2.1' | '3.0',
  documentReferences: BCFDocumentReference[]
): BCFProject {
  return {
    version,
    projectId: '99999999-9999-4999-8999-999999999999',
    topics: new Map([
      [
        '11111111-1111-4111-8111-111111111111',
        {
          guid: '11111111-1111-4111-8111-111111111111',
          title: 'Topic with an attached document',
          topicType: 'Issue',
          topicStatus: 'Open',
          creationDate: '2026-01-02T03:04:05Z',
          creationAuthor: 'author@example.invalid',
          documentReferences,
          comments: [],
          viewpoints: [],
        },
      ],
    ]),
  };
}

async function markupOf(project: BCFProject): Promise<string> {
  const zip = await JSZip.loadAsync(Buffer.from(await (await writeBCF(project)).arrayBuffer()));
  const name = Object.keys(zip.files).find((n) => n.endsWith('markup.bcf'))!;
  return zip.files[name].async('string');
}

async function markupErrors(version: '2.1' | '3.0', xml: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'subject.xml', contents: xml }],
    schema: [schema(version, 'markup.xsd')],
    preload:
      version === '3.0'
        ? [{ fileName: 'shared-types.xsd', contents: schema('3.0', 'shared-types.xsd') }]
        : [],
  });
  return result.valid ? [] : result.errors.map((e) => e.message);
}

/** No `guid` — what a caller writing to the 2.1-shaped optional field gives. */
const WITHOUT_GUID: BCFDocumentReference = {
  isExternal: true,
  url: 'https://example.invalid/spec.pdf',
  description: 'Cladding specification',
};

const CALLER_GUID = '33333333-3333-4333-8333-333333333333';

describe('DocumentReference/@Guid', () => {
  it('is supplied for BCF 3.0 when the caller left it unset', async () => {
    const xml = await markupOf(projectWith('3.0', [WITHOUT_GUID]));
    const guid = /<DocumentReference Guid="([^"]+)"/.exec(xml)?.[1];
    expect(guid, 'BUG: 3.0 requires the attribute and the writer omitted it').toBeTruthy();
    expect(isValidUuid(guid!), `generated guid ${guid} must satisfy the schema Guid type`).toBe(
      true
    );
    expect(await markupErrors('3.0', xml)).toEqual([]);
  });

  it('keeps the caller\'s own guid rather than overwriting it', async () => {
    const xml = await markupOf(projectWith('3.0', [{ ...WITHOUT_GUID, guid: CALLER_GUID }]));
    expect(xml).toContain(`<DocumentReference Guid="${CALLER_GUID}"`);
    expect(await markupErrors('3.0', xml)).toEqual([]);
  });

  /**
   * Two references in one topic must not collide: a single generated guid
   * reused for both would still validate against the attribute's type, and
   * would still be wrong.
   */
  it('gives two guid-less references distinct guids', async () => {
    const xml = await markupOf(
      projectWith('3.0', [WITHOUT_GUID, { ...WITHOUT_GUID, description: 'Second document' }])
    );
    const guids = [...xml.matchAll(/<DocumentReference Guid="([^"]+)"/g)].map((m) => m[1]);
    expect(guids).toHaveLength(2);
    expect(new Set(guids).size).toBe(2);
    expect(await markupErrors('3.0', xml)).toEqual([]);
  });

  /**
   * 2.1 keeps the attribute optional. Emitting a fabricated guid there would
   * put an identifier the caller never chose into the file a user downloads,
   * for no schema reason — and would make this fix invisible to a reader
   * trying to tell the two versions apart.
   */
  it('is left absent for BCF 2.1, whose schema makes it optional', async () => {
    const xml = await markupOf(projectWith('2.1', [WITHOUT_GUID]));
    expect(xml).toContain('<DocumentReference isExternal="true">');
    expect(xml).not.toMatch(/<DocumentReference Guid=/);
    expect(await markupErrors('2.1', xml)).toEqual([]);
  });
});
