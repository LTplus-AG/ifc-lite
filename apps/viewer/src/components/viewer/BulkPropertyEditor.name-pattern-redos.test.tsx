/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BulkPropertyEditor`'s "Name Pattern (Regex)" field sets
 * `criteria.namePattern`, which `BulkQueryEngine.select()` compiles into a
 * live `RegExp` and runs `.test()` with — once per candidate entity, inside
 * a `candidates.filter()` loop, so the cost multiplies across the whole
 * selection. `select()` now throws for a catastrophic-backtracking or
 * oversized pattern (`unsafeNamePatternReason`, mirroring
 * `packages/ids/src/constraints/xsd-regex.ts` and
 * `packages/lists/src/name-pattern.ts`'s guards for the same shape).
 *
 * A throw alone is not enough here: every call site that reaches
 * `queryEngine.select()` already wraps it in a try/catch (the live
 * match-count effect, `handlePreview`, `handleExecute`), so a throw would
 * NOT crash the panel — but the live-match effect's catch just
 * `console.warn`s and shows a plain "0 matches", which is silently
 * indistinguishable from "your pattern matched nothing". The field must
 * reject the pattern LOUDLY: a visible message the typing user actually
 * sees, per keystroke, without ever reaching `select()`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { BulkPropertyEditor } from './BulkPropertyEditor.js';

const MODEL_ID = 'model-a';
// Catastrophic against a name that does NOT match ('!' breaks the greedy
// first pass and forces the exponential backtracking search); unguarded,
// `(a+)+$` against 28 'a's + '!' measures >10s on this machine.
const CATASTROPHIC_PATTERN = '(a+)+$';

function seedStore() {
  const seeded = fixtureModels(
    fixtureModel(MODEL_ID, {
      entities: [
        { expressId: 1, type: 'IfcWall', name: 'Wall A' },
        { expressId: 2, type: 'IfcWall', name: 'Wall B' },
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

function getNamePatternInput(): HTMLInputElement {
  const input = [...document.body.querySelectorAll('input')].find(
    (i) => (i as HTMLInputElement).placeholder === 'e.g., Wall-.*-Exterior',
  ) as HTMLInputElement | undefined;
  assert.ok(input, 'Name Pattern (Regex) input must render');
  return input!;
}

describe('BulkPropertyEditor — namePattern ReDoS guard reaches the UI', () => {
  afterEach(() => {
    cleanup();
  });

  it('rejects a catastrophic namePattern quickly and shows a visible error, not a silent 0 matches', async () => {
    seedStore();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await advance(0);

    const start = Date.now();
    setNativeValue(getNamePatternInput(), CATASTROPHIC_PATTERN);
    // Let the match-count debounce (setTimeout(0) then setTimeout(200)) run.
    await advance(250);
    const elapsedMs = Date.now() - start;

    // Must not hang the render loop the way an unguarded `.test()` would.
    assert.ok(elapsedMs < 2000, `expected the rejection to be fast, took ${elapsedMs}ms`);

    const errorText = [...document.body.querySelectorAll('p')]
      .map((p) => p.textContent)
      .find((t) => t?.startsWith('Pattern rejected:'));
    assert.ok(errorText, 'the "Pattern rejected: ..." message must render next to the field');
    assert.match(errorText!, /catastrophic-backtracking shape/);
  });

  it('the Execute button stays disabled while a namePattern is rejected (no over-broad fallback selection)', async () => {
    seedStore();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await advance(0);

    setNativeValue(getNamePatternInput(), CATASTROPHIC_PATTERN);
    await advance(250);

    const executeBtn = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Apply to'),
    ) as HTMLButtonElement | undefined;
    assert.ok(executeBtn, 'Execute button must render');
    assert.equal(executeBtn!.disabled, true, 'Execute must stay disabled — the rejected filter must not silently widen to all entities');
  });

  it('REGRESSION GUARD: an ordinary namePattern still matches and is not flagged', async () => {
    seedStore();
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await advance(0);

    setNativeValue(getNamePatternInput(), '^Wall');
    await advance(250);

    const errorText = [...document.body.querySelectorAll('p')]
      .map((p) => p.textContent)
      .find((t) => t?.startsWith('Pattern rejected:'));
    assert.equal(errorText, undefined, 'an ordinary pattern must not be flagged as rejected');
  });
});
