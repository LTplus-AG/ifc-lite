/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleModelPicker` (#5138 plan §6): selection is written as
 * `sourceFingerprint`s, never a runtime model id, and a fingerprint the
 * file names that is not among the currently loaded models renders as
 * "not loaded" rather than silently dropping it.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { RuleModelPicker, type RuleModelPickerModel } from './RuleModelPicker.js';

const MODELS: RuleModelPickerModel[] = [
  { id: 'runtime-1', name: 'Architecture', sourceFingerprint: 'fp-arch' },
  { id: 'runtime-2', name: 'Structure', sourceFingerprint: 'fp-struct' },
];

function Harness({ initial, onValueChange }: { initial: string[] | undefined; onValueChange?: (v: string[] | undefined) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <RuleModelPicker
      models={MODELS}
      value={value}
      onChange={(next) => { setValue(next); onValueChange?.(next); }}
    />
  );
}

function modelButton(container: HTMLElement, label: string): HTMLElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  assert.ok(el, `no "${label}" button rendered`);
  return el!;
}

describe('RuleModelPicker (#5138)', () => {
  afterEach(cleanup);

  it('selecting a model persists its sourceFingerprint, never the runtime id', () => {
    let latest: string[] | undefined;
    const container = render(<Harness initial={undefined} onValueChange={(v) => { latest = v; }} />);

    click(modelButton(container, 'Architecture'));

    assert.deepEqual(latest, ['fp-arch']);
    assert.ok(!latest!.includes('runtime-1'), 'the runtime id must never be written');
  });

  it('toggling a second model adds its fingerprint; toggling back to none reverts to "All models"', () => {
    let latest: string[] | undefined;
    const container = render(<Harness initial={undefined} onValueChange={(v) => { latest = v; }} />);

    click(modelButton(container, 'Architecture'));
    click(modelButton(container, 'Structure'));
    assert.deepEqual(new Set(latest), new Set(['fp-arch', 'fp-struct']));

    click(modelButton(container, 'Architecture'));
    click(modelButton(container, 'Structure'));
    assert.equal(latest, undefined, 'deselecting every model reverts to "All models" (undefined), not an empty array');
  });

  it('a fingerprint the file names that is not among the loaded models shows "not loaded"', () => {
    const container = render(<Harness initial={['fp-unknown']} />);
    assert.match(container.textContent ?? '', /not loaded/i);
  });

  it('"All models" clears the selection', () => {
    let latest: string[] | undefined = ['fp-arch'];
    const container = render(<Harness initial={['fp-arch']} onValueChange={(v) => { latest = v; }} />);

    click(modelButton(container, 'All models'));
    assert.equal(latest, undefined);
  });

  it('a model with no fingerprint cannot be selected (disabled, with a title explaining why)', () => {
    function HarnessNoFingerprint() {
      const [value, setValue] = useState<string[] | undefined>(undefined);
      return (
        <RuleModelPicker
          models={[{ id: 'runtime-3', name: 'Unsaved' }]}
          value={value}
          onChange={setValue}
        />
      );
    }
    const container = render(<HarnessNoFingerprint />);
    const button = modelButton(container, 'Unsaved') as HTMLButtonElement;
    assert.equal(button.disabled, true);
    assert.ok(button.title.length > 0);
  });
});
