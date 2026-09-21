/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Set-level result rows (#5138 plan §6): `SetResult`s (duplicate groups /
 * aggregate checks) render as collapsible rows above the entity rows, and
 * clicking a row isolates its members through the existing isolate path.
 * `SpecificationCard` is generalised to `SpecificationResult` (#5138 plan
 * §5), so this exercises it directly with a rule-set-shaped fixture rather
 * than an `IDSSpecificationResult`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SetResult, SpecificationResult } from '@ifc-lite/ids';
import { cleanup, click, render } from '@/test/render.js';
import { SpecificationCard } from './IDSSpecificationCard.js';
import { SetResultRow } from './IDSResultRows.js';

function duplicateSet(): SetResult {
  return {
    kind: 'duplicate',
    label: 'unique(Name)',
    actual: 'Level 1 (2×)',
    expected: 'unique',
    passed: false,
    failureReason: 'duplicate',
    members: [
      { modelId: 'm1', expressId: 10 },
      { modelId: 'm1', expressId: 11 },
    ],
  };
}

function aggregateSet(passed: boolean): SetResult {
  return {
    kind: 'aggregate',
    label: 'sum(Qto_SpaceBaseQuantities.NetFloorArea)',
    groupKey: 'Building A',
    actual: '287.4 m²',
    expected: '> 300',
    passed,
    failureReason: passed ? undefined : 'aggregate',
    members: [{ modelId: 'm1', expressId: 20 }],
  };
}

function specResult(setResults: SetResult[]): SpecificationResult {
  return {
    specification: { id: 'spec-1', name: 'Floor area total' },
    status: 'fail',
    applicableCount: 3,
    passedCount: 0,
    failedCount: 0,
    passRate: 100,
    entityResults: [],
    setResults,
  };
}

afterEach(() => { cleanup(); });

describe('SetResultRow (#5138 set-level results)', () => {
  it('renders the label, actual/expected, and member count', () => {
    const isolated: SetResult['members'][] = [];
    const ui = render(<SetResultRow result={duplicateSet()} onIsolate={(m) => isolated.push(m)} />);
    assert.match(ui.textContent ?? '', /unique\(Name\)/);
    assert.match(ui.textContent ?? '', /Level 1 \(2×\)/);
    assert.match(ui.textContent ?? '', /2/); // member count
  });

  it('isolate click passes exactly the set\'s members', () => {
    const isolated: SetResult['members'][] = [];
    const set = duplicateSet();
    const ui = render(<SetResultRow result={set} onIsolate={(m) => isolated.push(m)} />);
    const isolateButton = [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Isolate');
    assert.ok(isolateButton, 'expected an Isolate button');
    click(isolateButton!);
    assert.strictEqual(isolated.length, 1);
    assert.deepStrictEqual(isolated[0], set.members);
  });

  it('expands to list member modelId:expressId on click', () => {
    const ui = render(<SetResultRow result={duplicateSet()} onIsolate={() => {}} />);
    assert.doesNotMatch(ui.textContent ?? '', /m1:10/);
    const toggle = ui.querySelector('button[aria-expanded]');
    assert.ok(toggle);
    click(toggle!);
    assert.match(ui.textContent ?? '', /m1:10/);
    assert.match(ui.textContent ?? '', /m1:11/);
  });
});

describe('SpecificationCard set-results section (#5138)', () => {
  it('renders a duplicate group and a failed aggregate above the entity rows', () => {
    const result = specResult([duplicateSet(), aggregateSet(false)]);
    const ui = render(
      <SpecificationCard
        result={result} isActive={false} onSelect={() => {}}
        onEntityClick={() => {}} onIsolateSet={() => {}} filterMode="all"
      />,
    );
    // Expand the card.
    const header = ui.querySelector('button');
    assert.ok(header);
    click(header!);
    assert.match(ui.textContent ?? '', /Set-level results/);
    assert.match(ui.textContent ?? '', /unique\(Name\)/);
    assert.match(ui.textContent ?? '', /sum\(Qto_SpaceBaseQuantities\.NetFloorArea\)/);
    // Summary line: one duplicate group, one failed aggregate check.
    assert.match(ui.textContent ?? '', /1 duplicate group/);
    assert.match(ui.textContent ?? '', /1 aggregate check failed/);
  });

  it('a passing aggregate does not count toward the failed-aggregate summary', () => {
    const result = specResult([aggregateSet(true)]);
    const ui = render(
      <SpecificationCard
        result={result} isActive={false} onSelect={() => {}}
        onEntityClick={() => {}} onIsolateSet={() => {}} filterMode="all"
      />,
    );
    assert.doesNotMatch(ui.textContent ?? '', /aggregate check(s)? failed/);
  });

  it('isolate on a card\'s set row reaches onIsolateSet with the members', () => {
    const isolated: SetResult['members'][] = [];
    const set = duplicateSet();
    const result = specResult([set]);
    const ui = render(
      <SpecificationCard
        result={result} isActive={false} onSelect={() => {}}
        onEntityClick={() => {}} onIsolateSet={(m) => isolated.push(m)} filterMode="all"
      />,
    );
    click(ui.querySelector('button')!);
    const isolateButton = [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Isolate');
    assert.ok(isolateButton);
    click(isolateButton!);
    assert.deepStrictEqual(isolated[0], set.members);
  });

  it('a specification with no set results renders no set-results section', () => {
    const result = specResult([]);
    const ui = render(
      <SpecificationCard
        result={result} isActive={false} onSelect={() => {}}
        onEntityClick={() => {}} onIsolateSet={() => {}} filterMode="all"
      />,
    );
    click(ui.querySelector('button')!);
    assert.doesNotMatch(ui.textContent ?? '', /Set-level results/);
  });
});
