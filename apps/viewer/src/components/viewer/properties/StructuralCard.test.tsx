/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StructuralCard renders `extractStructuralOnDemand`'s read model for the
 * selected `IfcStructuralMember`. Asserted against the real fixture
 * (`structural_analysis_curve.ifc`, the corpus's only structural-analysis
 * export — see #4206) rather than a synthetic extraction, so a regression in
 * how the card reads the shared read model shows up here the same way it
 * would in the parser's own fixture test.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StepTokenizer,
  ColumnarParser,
  extractStructuralOnDemand,
  type StructuralExtraction,
} from '@ifc-lite/parser';
import { StructuralCard } from './StructuralCard.js';

const FIXTURE = fileURLToPath(
  new URL('../../../../../../tests/models/ifcopenshell/structural_analysis_curve.ifc', import.meta.url),
);
const hasFixture = existsSync(FIXTURE);

async function parseFixture(): Promise<StructuralExtraction> {
  const source = new Uint8Array(readFileSync(FIXTURE));
  const tokenizer = new StepTokenizer(source);
  const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const parser = new ColumnarParser();
  const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
  return extractStructuralOnDemand(store);
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: ReactElement): string {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host.textContent ?? '';
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const maybeIt = hasFixture ? it : it.skip;
const skipMsg = hasFixture ? '' : ' (fixture absent — run `pnpm fixtures`)';

describe(`StructuralCard against structural_analysis_curve.ifc${skipMsg}`, () => {
  maybeIt('renders the loaded member\'s analysis model, connections and the exact applied load', async () => {
    const data = await parseFixture();
    const action = data.activities.find((a) => a.kind === 'Action');
    assert.ok(action, 'expected the one applied action');
    const loaded = data.members.find((m) => m.activityGlobalIds.includes(action!.globalId));
    assert.ok(loaded, 'expected the member the action applies to');

    const text = render(
      <StructuralCard
        structuralData={data}
        selectedExpressId={loaded!.expressId}
        selectedGlobalId={loaded!.globalId}
      />,
    );

    assert.ok(text.includes('Structural Analysis #1'), `analysis model name in: ${text}`);
    // #327/#329: IFCSTRUCTURALLOADLINEARFORCE(.,$,$,-100.,$,$,$) at Locations
    // [96] and [192] — the pinned value from #4677's own evidence.
    assert.ok(text.includes('LinearForceZ: -100'), `LinearForceZ: -100 in: ${text}`);
    assert.ok(text.includes('96'), `location 96 in: ${text}`);
    assert.ok(text.includes('192'), `location 192 in: ${text}`);
    // Every member spans exactly two connections (continuous-beam fixture).
    assert.ok(text.includes('Connections (2)'), `connection count in: ${text}`);
    // loadsTruncated is false for this small, complete fixture.
    assert.ok(!text.includes('Truncated'), `no truncated badge in: ${text}`);
  });

  maybeIt('summarizes a fixed support as all six DOFs fixed, not as the number 1', async () => {
    const data = await parseFixture();
    const fixedConnection = data.connections.find((c) => c.appliedCondition !== undefined);
    assert.ok(fixedConnection, 'expected a connection with a boundary condition');
    const member = data.members.find((m) => m.connectionGlobalIds.includes(fixedConnection!.globalId));
    assert.ok(member, 'expected a member joined to the fixed connection');

    const text = render(
      <StructuralCard
        structuralData={data}
        selectedExpressId={member!.expressId}
        selectedGlobalId={member!.globalId}
      />,
    );
    assert.ok(text.includes('6 DOFs fixed') || text.includes('6/6 DOFs fixed'), `six fixed DOFs in: ${text}`);
    assert.ok(text.includes('Fixed'), `boundary condition name in: ${text}`);
  });

  maybeIt('distinguishes a truncated extraction from a complete one', async () => {
    const data = await parseFixture();
    const action = data.activities.find((a) => a.kind === 'Action')!;
    const loaded = data.members.find((m) => m.activityGlobalIds.includes(action.globalId))!;

    const complete = render(
      <StructuralCard structuralData={data} selectedExpressId={loaded.expressId} selectedGlobalId={loaded.globalId} />,
    );
    assert.ok(!complete.includes('Truncated'), `complete fixture shows no truncated badge: ${complete}`);

    const truncated: StructuralExtraction = { ...data, loadsTruncated: true };
    const truncatedText = render(
      <StructuralCard structuralData={truncated} selectedExpressId={loaded.expressId} selectedGlobalId={loaded.globalId} />,
    );
    assert.ok(truncatedText.includes('Truncated'), `truncated fixture shows the badge: ${truncatedText}`);
  });

  maybeIt('renders nothing when the selection is not a structural member', async () => {
    const data = await parseFixture();
    const text = render(
      <StructuralCard structuralData={data} selectedExpressId={999999} selectedGlobalId="not-a-real-globalid" />,
    );
    assert.equal(text, '');
  });

  maybeIt('renders nothing given a null extraction', () => {
    const text = render(<StructuralCard structuralData={null} selectedExpressId={1} selectedGlobalId="x" />);
    assert.equal(text, '');
  });
});

describe('StructuralCard synthetic boundary-condition invariants', () => {
  it('reports numeric stiffness as elastic instead of fixed', () => {
    const data: StructuralExtraction = {
      analysisModels: [],
      members: [{
        expressId: 10,
        globalId: 'member',
        type: 'IfcStructuralCurveMember',
        connectionGlobalIds: ['connection'],
        activityGlobalIds: [],
        analysisModelGlobalIds: [],
      }],
      connections: [{
        expressId: 20,
        globalId: 'connection',
        type: 'IfcStructuralPointConnection',
        appliedCondition: {
          expressId: 30,
          type: 'IfcBoundaryNodeCondition',
          components: {
            TranslationalStiffnessX: true,
            TranslationalStiffnessY: false,
            TranslationalStiffnessZ: 1500,
          },
        },
        memberGlobalIds: ['member'],
        activityGlobalIds: [],
        analysisModelGlobalIds: [],
      }],
      activities: [],
      loadGroups: [],
      resultGroups: [],
      hasStructural: true,
      loadsTruncated: false,
    };

    const text = render(
      <StructuralCard structuralData={data} selectedExpressId={10} selectedGlobalId="member" />,
    );
    assert.ok(text.includes('1 DOF fixed'), `boolean true is fixed in: ${text}`);
    assert.ok(text.includes('1 DOF elastic'), `numeric stiffness is elastic in: ${text}`);
    assert.ok(text.includes('1 DOF free'), `boolean false is free in: ${text}`);
    assert.ok(!text.includes('3 DOFs fixed'), `numeric stiffness must not be called fixed in: ${text}`);
  });
});
