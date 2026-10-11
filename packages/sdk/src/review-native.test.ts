/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { snapshotFrom, validationFindings, type ReviewModel } from './review.js';

const samples = new URL('../../../apps/viewer/public/samples/', import.meta.url);
const document = parseIDS(readFileSync(new URL('building-architecture.ids', samples), 'utf8'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('#7372 shared native Review normalization over the real SketchUp revision sources', () => {
  for (const file of ['building-architecture.ifc', 'building-architecture-rev-b.ifc']) {
    it(`retains native failed requirement rows, ownership and stale coverage: ${file}`, async () => {
      const bytes = new Uint8Array(readFileSync(new URL(file, samples)));
      const before = digest(bytes);
      const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
      if (!store.schemaVersion) throw new Error('Real IFC source schema unavailable');
      const modelId = file;
      const report = await validateIDS(document, createDataAccessor(store),
        { modelId, schemaVersion: store.schemaVersion, entityCount: store.entityCount }, { includePassingEntities: true });
      expect(report.specificationResults.length).toBeGreaterThan(0);
      expect(report.specificationResults.every(spec => !spec.error)).toBe(true);
      const nativeFailures = report.specificationResults.flatMap(spec => spec.entityResults
        .filter(entity => !entity.passed).map(entity => ({ specificationId: spec.specification.id,
          expressId: entity.expressId, globalId: entity.globalId ?? store.entities.getGlobalId(entity.expressId) ?? '',
          // IDS specifications have no information-rule warning severity.
          modelId: entity.modelId, nativeStatus: 'failed' as const })));
      expect(nativeFailures.length).toBeGreaterThan(0);
      const models: ReviewModel[] = [{ id: modelId, name: file,
        expressIdOf: guid => store.entities.getExpressIdByGlobalId(guid),
        globalIdOf: id => store.entities.getGlobalId(id) ?? '' }];
      const collect = (stale: boolean) => snapshotFrom([{ kind: 'validation',
        collect: selected => validationFindings({ report, stale }, selected) }], models);
      const current = collect(false);
      expect(current.failed).toEqual([]);
      expect(current.findings.map(finding => {
        expect(finding.evidence.kind).toBe('validation');
        if (finding.evidence.kind !== 'validation') throw new Error('Native validation evidence lost');
        const element = finding.elements[0]; expect(element).toBeDefined();
        return { specificationId: finding.evidence.specificationId, expressId: finding.evidence.expressId,
          modelId: finding.evidence.modelId, globalId: element?.globalId, nativeStatus: finding.nativeStatus };
      })).toEqual(nativeFailures);
      expect(current.totals.currentFindings).toBe(nativeFailures.length);
      expect(current.runs[0]?.complete).toBe(true);
      const stale = collect(true);
      expect(stale.runs[0]?.complete).toBe(false);
      expect(stale.runs[0]?.incomplete).toEqual([{ code: 'stale' }]);
      expect(stale.findings.map(finding => [finding.nativeStatus, finding.elements])).toEqual(
        current.findings.map(finding => [finding.nativeStatus, finding.elements]));
      expect(digest(store.source.materialize())).toBe(before);
      expect(report.specificationResults.flatMap(spec => spec.entityResults.filter(entity => !entity.passed)).length)
        .toBe(nativeFailures.length);
    }, 20_000);
  }
});
