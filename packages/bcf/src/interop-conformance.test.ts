/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every entry of a PLAIN export must validate against the official BCF XSDs.
 *
 * `schema-validation.test.ts` validates a deliberately maximal fixture, hand
 * built from the `BCFTopic` type. This file validates the archive a user
 * actually gets: one assembled only through the package's public convenience
 * helpers — `createBCFProject`, `createBCFTopic`, `createBCFComment`,
 * `createViewpoint` — which is the exact sequence the viewer's BCF panel, the
 * CLI's `clash --bcf`, and the MCP `bcf` tools all follow. Nothing here sets a
 * field by hand, so the defaults those helpers choose are what gets validated.
 *
 * That distinction is not cosmetic. The defect this file was written for
 * (issue #3612: BCF exports imported as empty in Solibri, BIMcollab and BIM+)
 * lived in `project.bcfp`, an entry the maximal fixture also produced — but
 * whose 2.1 invalidity had been pinned as an accepted gap rather than fixed,
 * precisely because no test asked "does the file a user downloads validate,
 * end to end, entry by entry?". This one does, and it fails if ANY entry
 * fails, so a violation cannot be scoped away one entry at a time.
 *
 * Validation runs against the vendored buildingSMART schemas through
 * `xmllint-wasm` — an authority independent of this codebase's own reader,
 * which is the only kind that can see an interop bug. A write/read round trip
 * through `readBCF` would pass on every one of these files even when no
 * third-party tool can open them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { writeBCF } from './writer.js';
import { createViewpoint } from './viewpoint.js';
import {
  addCommentToTopic,
  addTopicToProject,
  addViewpointToTopic,
  createBCFComment,
  createBCFProject,
  createBCFTopic,
} from './index.js';
import type { BCFProject } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function schema(version: '2.1' | '3.0', file: string): string {
  const dir = version === '2.1' ? 'v2_1' : 'v3_0';
  return readFileSync(path.join(DIR, '__fixtures__', 'schemas', dir, file), 'utf8');
}

/** The XSD that governs each archive entry, keyed by how the entry is named. */
const SCHEMA_FOR_ENTRY: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)bcf\.version$/, 'version.xsd'],
  [/(^|\/)project\.bcfp$/, 'project.xsd'],
  [/(^|\/)markup\.bcf$/, 'markup.xsd'],
  [/\.bcfv$/, 'visinfo.xsd'],
];

/**
 * Build the archive a user downloads, using only the public helpers.
 *
 * The camera mirrors what the viewer captures: `Camera.getFOV()` returns
 * radians and defaults to `Math.PI / 4`, which `cameraToPerspective` turns
 * into 45 degrees — the exact lower bound of BCF 2.1's `FieldOfView` facet,
 * so this doubles as the boundary case for that range.
 */
function plainExport(version: '2.1' | '3.0'): BCFProject {
  const project = createBCFProject({ name: 'Coordination', version });
  const topic = createBCFTopic({
    title: 'Duct clashes with beam at grid B/3',
    description: 'The supply duct passes through the beam web.',
    author: 'reporter@example.invalid',
  });
  addTopicToProject(project, topic);
  addCommentToTopic(
    topic,
    createBCFComment({ author: 'reviewer@example.invalid', comment: 'Reroute below the beam.' })
  );
  addViewpointToTopic(
    topic,
    createViewpoint({
      camera: {
        position: { x: 12.5, y: 8.25, z: 3.75 },
        target: { x: 0, y: 1.5, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        fov: Math.PI / 4,
        isOrthographic: false,
      },
      // The user's report singles out selected objects by GUID; a viewpoint
      // with no selection could not show them going missing.
      selectedGuids: ['0GbQ8$mZH4$8dFR$JUFRuF', '1kTvXnbbzCWw8lcMd1dR4o'],
      snapshot: 'data:image/png;base64,iVBORw0KGgo=',
    })
  );
  return project;
}

async function entriesOf(project: BCFProject): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await (await writeBCF(project)).arrayBuffer());
  const out = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    if (SCHEMA_FOR_ENTRY.some(([re]) => re.test(name))) {
      out.set(name, await zip.files[name].async('string'));
    }
  }
  return out;
}

/**
 * 2.1 only, and that is the point rather than a shortcut: `createBCFProject`
 * defaults to 2.1 and every caller in this repository takes that default, so
 * 2.1 is the archive users actually get. A plain 3.0 export cannot even be
 * built through these helpers today — 3.0's `visinfo.xsd` requires
 * `AspectRatio` on both camera types, `ViewerCameraState` carries none, so
 * `createViewpoint` produces a camera the writer refuses (deliberately) rather
 * than emitting an invalid archive. `schema-validation.test.ts` covers 3.0
 * from a hand-built fixture that supplies the field.
 */
describe('a plainly-exported archive validates entry by entry', () => {
  for (const version of ['2.1'] as const) {
    it(`BCF ${version}`, async () => {
      const entries = await entriesOf(plainExport(version));

      // Guard against a vacuous pass: an export that stopped emitting
      // project.bcfp, or the viewpoint, would otherwise validate trivially.
      const kinds = [...entries.keys()].map((n) => n.replace(/^[^/]+\//, ''));
      expect(kinds).toContain('bcf.version');
      expect(kinds).toContain('project.bcfp');
      expect(kinds).toContain('markup.bcf');
      expect(kinds.some((n) => n.endsWith('.bcfv'))).toBe(true);

      // Collect every entry's verdict before asserting, so one failure does
      // not hide the others — three tools rejecting an archive is rarely one
      // violation, and a per-entry `expect` would only ever show the first.
      const failures: string[] = [];
      for (const [name, xml] of entries) {
        const xsd = SCHEMA_FOR_ENTRY.find(([re]) => re.test(name))![1];
        const result = await validateXML({
          // xmllint reads a leading dash as a flag and the real entry names
          // contain `/`; a fixed inert name keeps both out of the argv.
          xml: [{ fileName: 'subject.xml', contents: xml }],
          schema: [schema(version, xsd)],
          // No preload needed: this sweep is 2.1-only (see the block comment
          // above), and 2.1's schemas are self-contained. A 3.0 archive would
          // need shared-types.xsd preloaded for its cross-schema references;
          // `schema-validation.test.ts` covers that case.
          preload: [],
        });
        if (!result.valid) {
          failures.push(`${name} [${xsd}]: ${result.errors.map((e) => e.message).join(' | ')}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
