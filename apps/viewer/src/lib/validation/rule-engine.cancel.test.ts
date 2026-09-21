/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runRuleSet` cancellation (#5138 PR 3, plan §4 item 10): an `AbortSignal`
 * aborted mid-run must reject with `AbortError`, and the report object is
 * only ever constructed AFTER every rule finishes (`rule-engine.ts`'s
 * `runRuleSet` — the `return { source, modelInfo, … }` is the function's
 * last statement), so a caller can never observe a partial one.
 *
 * A small fixture would let the whole run finish SYNCHRONOUSLY before
 * `controller.abort()` (called right after `runRuleSet(...)`) ever executes
 * — the federated evaluator only actually yields to the event loop (the
 * point where an abort can land) once a model's candidate set exceeds its
 * own internal chunk size (`DEFAULT_CHUNK_SIZE = 20_000`,
 * `filter-evaluate.ts`). This fixture is generated well above that so the
 * abort has a real chunk boundary to land on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { runRuleSet } from './rule-engine.js';
import type { InformationRule, RuleSetFile } from './rule-set.js';
import { Rule } from '../search/filter-rules.js';
import type { ModelTagState } from '../model-tags/evaluator-models.js';

const WALL_COUNT = 25_000;

function generateWallsStep(count: number): string {
  const lines: string[] = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);",
    "#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);",
    '#21= IFCAXIS2PLACEMENT3D(#22,$,$);',
    '#22= IFCCARTESIANPOINT((0.,0.,0.));',
    '#30= IFCUNITASSIGNMENT((#31));',
    '#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    '#40= IFCLOCALPLACEMENT($,#21);',
  ];
  for (let i = 0; i < count; i++) {
    const id = 1000 + i;
    const gid = `0Wall${String(i).padStart(17, '0')}`;
    lines.push(`#${id}= IFCWALL('${gid}',$,'Wall ${i}',$,$,#40,$,'tag',$);`);
  }
  lines.push('ENDSEC;', 'END-ISO-10303-21;', '');
  return lines.join('\n');
}

async function parseGeneratedWalls(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(generateWallsStep(WALL_COUNT));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function stateFor(store: IfcDataStore): ModelTagState {
  return {
    models: new Map([['m1', { id: 'm1', sourceFingerprint: undefined, ifcDataStore: store }]]),
    modelTags: new Map(),
    modelTagAssignments: new Map(),
  };
}

describe('runRuleSet — cancellation (#5138)', () => {
  it('aborting mid-run rejects with AbortError and never resolves with a report', async () => {
    const store = await parseGeneratedWalls();
    const rule: InformationRule = {
      id: 'r1', name: 'every wall',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: [Rule.name('contains', '')], combinator: 'AND' }], authoredAs: 'chips' } },
    };
    const ruleSet: RuleSetFile = { version: 1, name: 'test', rules: [rule] };
    const controller = new AbortController();

    let resolvedReport: unknown = 'NEVER_ASSIGNED';
    const promise = runRuleSet({ ruleSet, models: stateFor(store), signal: controller.signal })
      .then((report) => { resolvedReport = report; return report; });
    // Called synchronously right after starting the run — lands during the
    // federated evaluator's chunked scan for a fixture this size (see the
    // module doc for why a smaller one would not exercise this at all).
    controller.abort();

    await assert.rejects(promise, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
    assert.equal(resolvedReport, 'NEVER_ASSIGNED', 'the report must never resolve after an abort — no partial report is ever produced');
  });
});
