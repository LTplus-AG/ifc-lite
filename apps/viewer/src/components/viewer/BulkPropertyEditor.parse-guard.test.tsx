/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BulkPropertyEditor.buildAction()` fed the "New Value" field through
 * `parseFloat(targetValue) || 0` / `parseInt(targetValue, 10) || 0` for a
 * Real/Integer SET_PROPERTY action. `NaN || 0` is `0`, so a non-numeric
 * entry silently built an action carrying a fabricated `0` — and because
 * that ONE `BulkAction` object is reused for every entity in the matched
 * selection (`handleExecute`'s per-entity `queryEngine.applyAction(id,
 * action)` loop), a single bad value would write a fabricated `0` across
 * the ENTIRE selection at once. See PR #3456 (same defect in
 * `CsvConnector.parseValue`) and the sibling record on that PR's thread.
 *
 * `parseBulkSetPropertyValue` (unit-tested below) is the fix's pure core;
 * the component tests drive the real dialog end to end (the fixture-store
 * pattern `BulkPropertyEditor.collab-gate.test.tsx` uses) to prove the
 * all-or-nothing property: an unparseable value must refuse the WHOLE
 * execute before touching a single entity, not half-apply across the
 * selection.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkPropertyEditor, parseBulkSetPropertyValue } from './BulkPropertyEditor.js';

const MODEL_ID = 'model-a';
const PSET = 'Pset_Test';
const PROP = 'Foo';

// ─── Unit tests: the pure parse core ───────────────────────────────────────

describe('parseBulkSetPropertyValue', () => {
  it('rejects a non-numeric Real entry instead of fabricating 0', () => {
    const result = parseBulkSetPropertyValue('N/A', PropertyValueType.Real);
    assert.equal(result.ok, false);
  });

  it('rejects a non-numeric Integer entry instead of fabricating 0', () => {
    const result = parseBulkSetPropertyValue('TBD', PropertyValueType.Integer);
    assert.equal(result.ok, false);
  });

  it('REGRESSION GUARD: accepts a genuine "0" Real entry as 0', () => {
    const result = parseBulkSetPropertyValue('0', PropertyValueType.Real);
    assert.deepEqual(result, { ok: true, value: 0 });
  });

  it('REGRESSION GUARD: accepts a genuine "0" Integer entry as 0', () => {
    const result = parseBulkSetPropertyValue('0', PropertyValueType.Integer);
    assert.deepEqual(result, { ok: true, value: 0 });
  });

  it('accepts a valid Real entry', () => {
    const result = parseBulkSetPropertyValue('3.14', PropertyValueType.Real);
    assert.deepEqual(result, { ok: true, value: 3.14 });
  });

  it('accepts a valid Integer entry', () => {
    const result = parseBulkSetPropertyValue('42', PropertyValueType.Integer);
    assert.deepEqual(result, { ok: true, value: 42 });
  });

  it('rejects an empty Real/Integer entry (no "unset" affordance in this bulk form)', () => {
    assert.equal(parseBulkSetPropertyValue('', PropertyValueType.Real).ok, false);
    assert.equal(parseBulkSetPropertyValue('', PropertyValueType.Integer).ok, false);
  });

  it('String/Label entries pass through unparsed', () => {
    assert.deepEqual(parseBulkSetPropertyValue('hello', PropertyValueType.String), { ok: true, value: 'hello' });
  });
});

// ─── Component tests: the dialog end to end ────────────────────────────────

function seedStore() {
  const seeded = fixtureModels(
    fixtureModel(MODEL_ID, {
      entities: [
        { expressId: 1, type: 'IfcWall', name: 'Wall A' },
        { expressId: 2, type: 'IfcWall', name: 'Wall B' },
        { expressId: 3, type: 'IfcWall', name: 'Wall C' },
      ],
    }),
  );
  useViewerStore.setState({
    ...seeded,
    mutationViews: new Map(),
    mutationVersion: 0,
    collabRole: null,
  });
}

function openDialog(container: HTMLElement): void {
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open'));
  assert.ok(trigger, 'dialog trigger button must render');
  click(trigger!);
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Fills Property Set / Property Name / New Value, switches the value-type
 *  Select to `typeLabel` via the real Radix control, waits for the
 *  match-count debounce, then clicks Execute. */
async function fillSetPropertyAndExecute(newValue: string, typeLabel: string): Promise<void> {
  await advance(0);

  const psetInput = [...document.body.querySelectorAll('input')].find(
    (i) => i.placeholder === 'e.g., Pset_WallCommon',
  ) as HTMLInputElement | undefined;
  const propInput = [...document.body.querySelectorAll('input')].find(
    (i) => i.placeholder === 'e.g., FireRating',
  ) as HTMLInputElement | undefined;
  const valueInput = [...document.body.querySelectorAll('input')].find(
    (i) => i.placeholder === 'Value',
  ) as HTMLInputElement | undefined;
  assert.ok(psetInput && propInput && valueInput, 'Property Set / Property Name / New Value inputs must render');

  setNativeValue(psetInput!, PSET);
  setNativeValue(propInput!, PROP);
  setNativeValue(valueInput!, newValue);

  // Switch the value-type Select from its String default to `typeLabel`.
  const typeSelectTrigger = [...document.body.querySelectorAll('button[role="combobox"]')].find((b) =>
    b.textContent?.includes('String'),
  );
  assert.ok(typeSelectTrigger, 'value-type Select trigger must render');
  click(typeSelectTrigger!);
  await advance(0);
  const option = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === typeLabel);
  assert.ok(option, `${typeLabel} option must render in the value-type Select`);
  click(option!);
  await advance(0);

  // Let the match-count debounce (setTimeout(0) then setTimeout(200)) resolve
  // so `liveMatchCount` becomes non-zero and the Execute button un-disables.
  await advance(250);

  const executeBtn = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Apply to'),
  ) as HTMLButtonElement | undefined;
  assert.ok(executeBtn, 'Execute ("Apply to N entities") button must render');
  click(executeBtn!);
  await advance(0);
}

describe('BulkPropertyEditor — Real/Integer parse guard (buildAction / handleExecute)', () => {
  afterEach(() => {
    cleanup();
  });

  it('a non-numeric Real value writes nothing to ANY matched entity (all-or-nothing, not half-applied)', async () => {
    seedStore();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await fillSetPropertyAndExecute('N/A', 'Real');

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view, 'a mutation view is registered for the model');
    for (const id of [1, 2, 3]) {
      assert.equal(
        view!.getPropertyValue(id, PSET, PROP),
        null,
        `entity ${id} must not receive a fabricated 0 — the whole bulk write must be refused, not half-applied`,
      );
    }

    // Surfaced via this component's own error Alert (`executeResult`), the
    // pattern it already uses for a failed execute — not a new UI.
    const errorAlert = [...document.body.querySelectorAll('*')].find((el) => el.textContent === 'Error');
    assert.ok(errorAlert, 'the Error alert must render, explaining the value did not parse');
  });

  it('a non-numeric Integer value writes nothing to any matched entity', async () => {
    seedStore();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await fillSetPropertyAndExecute('TBD', 'Integer');

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view);
    for (const id of [1, 2, 3]) {
      assert.equal(view!.getPropertyValue(id, PSET, PROP), null);
    }
  });

  it('REGRESSION GUARD: a genuine "0" Real value still applies 0 across the whole selection', async () => {
    seedStore();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await fillSetPropertyAndExecute('0', 'Real');

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view);
    for (const id of [1, 2, 3]) {
      assert.equal(
        view!.getPropertyValue(id, PSET, PROP),
        0,
        `entity ${id} must receive the genuinely-entered 0 — the fix must not reject real zeros`,
      );
    }
  });

  it('a valid Real value applies across the whole selection (sanity check on the harness)', async () => {
    seedStore();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await fillSetPropertyAndExecute('3.14', 'Real');

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view);
    for (const id of [1, 2, 3]) {
      assert.equal(view!.getPropertyValue(id, PSET, PROP), 3.14);
    }
  });
});
