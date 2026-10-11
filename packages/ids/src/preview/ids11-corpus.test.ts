/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW against the whole buildingSMART IDS 1.0 corpus (IDS-124).
 *
 * The acceptance for the preview is "1.0 export unaffected". Two claims:
 *  1. Byte identity. For every corpus file, the default writer output equals
 *     the output with the preview flag on, both for the default parse and
 *     for a preview parse (a 1.0 file uses no 1.1 XML feature, so nothing
 *     may change). Default-mode behaviour itself is pinned by
 *     `__corpus__/corpus.test.ts` and the writer tests, which this pitch
 *     leaves untouched.
 *  2. Verdicts. Parsed and validated in preview mode (which applies the
 *     #418 tolerance candidate to every simple value), every pass-/fail-
 *     case still gets its expected verdict, and the preview audit keeps the
 *     IDS 1.0 audit's conclusions on all 334 files.
 *
 * The corpus is CC BY-ND 4.0 and only read here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { writeIdsXml } from '../writer/index.js';
import { validateIDS } from '../validation/validator.js';
import { auditIDSDocument } from '../audit/index.js';
import { createDataAccessor } from '../bridge/index.js';
import { findIds11Features } from './features.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '__corpus__', 'buildingsmart-ids');
const PREVIEW = { preview: { ids11: true } } as const;

interface Case { id: string; prefix: 'pass' | 'fail' | 'invalid'; ids: string; ifc: string }

function collect(): Case[] {
  const out: Case[] = [];
  for (const group of readdirSync(ROOT).sort()) {
    const dir = join(ROOT, group);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.ids')) continue;
      const prefix = name.split('-')[0] as Case['prefix'];
      out.push({
        id: `${relative(ROOT, dir)}/${name.slice(0, -4)}`,
        prefix,
        ids: readFileSync(join(dir, name), 'utf8'),
        ifc: join(dir, `${name.slice(0, -4)}.ifc`),
      });
    }
  }
  return out;
}

const CASES = collect();
const MODEL_CASES = CASES.filter((c) => c.prefix !== 'invalid');

/** Parse failures are part of the 1.0 behaviour and must match too. */
function writeOrError(produce: () => string): string {
  try {
    return produce();
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

describe('IDS 1.1 preview leaves IDS 1.0 untouched across the corpus', () => {
  it('discovers the corpus (334 files)', () => {
    expect(CASES).toHaveLength(334);
    expect(MODEL_CASES).toHaveLength(307);
  });

  it('writes byte-identical IDS 1.0 with and without the preview, for default and preview parses', () => {
    const differing: string[] = [];
    for (const c of CASES) {
      const baseline = writeOrError(() => writeIdsXml(parseIDS(c.ids)));
      const flagOnly = writeOrError(() => writeIdsXml(parseIDS(c.ids), {}, PREVIEW));
      const previewParse = writeOrError(() => writeIdsXml(parseIDS(c.ids, PREVIEW), {}, PREVIEW));
      if (baseline !== flagOnly || baseline !== previewParse) differing.push(c.id);
    }
    expect(differing).toEqual([]);
  });

  it('finds no 1.1 XML feature in any IDS 1.0 file', () => {
    const withXmlFeature = CASES.flatMap((c) => {
      try {
        const uses = findIds11Features(parseIDS(c.ids, PREVIEW)).filter((u) => u.feature !== 'tolerance-418');
        return uses.length > 0 ? [c.id] : [];
      } catch {
        return []; // a parse failure is covered by the identity test above
      }
    });
    expect(withXmlFeature).toEqual([]);
  });

  it('keeps every pass-/fail- verdict under the #418 tolerance candidate', async () => {
    const wrong: string[] = [];
    for (const c of MODEL_CASES) {
      const bytes = readFileSync(c.ifc);
      const store = await new IfcParser().parseColumnar(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      const report = await validateIDS(parseIDS(c.ids, PREVIEW), createDataAccessor(store), {
        modelId: c.id,
        schemaVersion: String(store.schemaVersion ?? 'IFC4'),
        entityCount: 0,
      }, PREVIEW);
      const status = report.specificationResults[0]?.status;
      if (status !== c.prefix) wrong.push(`${c.id}: ${status}`);
    }
    expect(wrong).toEqual([]);
  }, 180_000);

  it('reaches the same audit conclusion as IDS 1.0 on every file', async () => {
    const changed: string[] = [];
    for (const c of CASES) {
      const plain = await auditIDSDocument(c.ids);
      const preview = await auditIDSDocument(c.ids, PREVIEW);
      const codes = (r: typeof plain) => r.issues.filter((i) => i.severity !== 'info').map((i) => `${i.code}@${i.path}`).sort().join(',');
      if (codes(plain) !== codes(preview)) changed.push(c.id);
    }
    expect(changed).toEqual([]);
  }, 180_000);
});
