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

// Reuses `rule-engine.limit.test.ts`'s 6 000-wall generator shape — large
// enough to exceed `rule-engine-chunk.ts`'s `ENTITY_CHUNK_SIZE` (2 000), so
// `checkUnique`'s own chunk-boundary abort check (added on review: plan §4
// item 10 applies to EVERY requirement kind, not only `element`) has a real
// boundary to land on partway through the requirement-checking phase, not
// just during applicability.
const UNIQUE_WALL_COUNT = 6_000;

function generateWallsStepFor(count: number): string {
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

async function parseUniqueWalls(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(generateWallsStepFor(UNIQUE_WALL_COUNT));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// One over ENTITY_CHUNK_SIZE (2 000, rule-engine-chunk.ts) — the residual
// chunk (element 2001) never hits another `maybeYieldChunk` boundary.
async function parseUniqueWalls2001(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(generateWallsStepFor(2_001));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe('runRuleSet — cancellation (#5138)', () => {
  it('aborting mid-unique (6 000-wall fixture) rejects with AbortError and never resolves with a report', async () => {
    const store = await parseUniqueWalls();
    const rule: InformationRule = {
      id: 'r1', name: 'unique names',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'unique', subject: { kind: 'name' } },
    };
    const ruleSet: RuleSetFile = { version: 1, name: 'test', rules: [rule] };
    const controller = new AbortController();

    let resolvedReport: unknown = 'NEVER_ASSIGNED';
    const promise = runRuleSet({ ruleSet, models: stateFor(store), signal: controller.signal })
      .then((report) => { resolvedReport = report; return report; });
    controller.abort();

    await assert.rejects(promise, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
    assert.equal(resolvedReport, 'NEVER_ASSIGNED', 'the report must never resolve after an abort mid-unique either');
  });

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

  it('aborting from inside onProgress AT the last chunk boundary still rejects (review: the residual was never abort-checked)', async () => {
    // 2001 applicable elements, ENTITY_CHUNK_SIZE 2000: `maybeYieldChunk`'s
    // OWN abort check at done=2000 runs BEFORE onProgress is invoked, so
    // aborting synchronously FROM WITHIN that callback is only visible on
    // the NEXT check — the 2001st element never hits another chunk boundary
    // (2001 % 2000 !== 0), so without `finalProgress` also checking the
    // signal, the run would silently finish and resolve.
    const store = await parseUniqueWalls2001();
    const rule: InformationRule = {
      id: 'r1', name: 'every wall',
      applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: [Rule.name('contains', '')], combinator: 'AND' }], authoredAs: 'chips' } },
    };
    const ruleSet: RuleSetFile = { version: 1, name: 'test', rules: [rule] };
    const controller = new AbortController();

    let resolvedReport: unknown = 'NEVER_ASSIGNED';
    const promise = runRuleSet({
      ruleSet,
      models: stateFor(store),
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'requirements' && p.done === 2000) controller.abort();
      },
    }).then((report) => { resolvedReport = report; return report; });

    await assert.rejects(promise, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
    assert.equal(resolvedReport, 'NEVER_ASSIGNED', 'a late abort at the residual chunk must still reject, not resolve');
  });
});
