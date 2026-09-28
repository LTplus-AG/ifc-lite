/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphicOverrideRule } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { activate, cleanup, render, type } from '@/test/render.js';
import { DrawingSettingsPanel } from './DrawingSettingsPanel.js';

const rule: GraphicOverrideRule = {
  id: 'keyboard-rule',
  name: 'Keyboard rule',
  enabled: true,
  priority: 100,
  criteria: { type: 'ifcType', ifcTypes: ['IfcWall'], includeSubtypes: true },
  style: { fillColor: '#808080', strokeColor: '#000000' },
};

afterEach(() => {
  cleanup();
  useViewerStore.setState({ customOverrideRules: [] });
});

for (const key of ['Enter', ' '] as const) {
  it(`#5823 ${key === ' ' ? 'Space' : key} opens a custom drawing rule for editing`, () => {
    useViewerStore.setState({ customOverrideRules: [rule] });
    const ui = render(<DrawingSettingsPanel />);
    const edit = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes(rule.name));
    assert.ok(edit);
    activate(edit, key);
    assert.ok(ui.querySelector('input[value="Keyboard rule"]'), 'the rule name becomes editable');
  });
}

it('#5811 names the drawing-rule toggle for its current action', () => {
  useViewerStore.setState({ customOverrideRules: [rule] });
  const ui = render(<DrawingSettingsPanel />);
  const disable = ui.querySelector<HTMLButtonElement>('button[aria-label="Disable Keyboard rule"]');
  assert.ok(disable);
  activate(disable, 'Enter');
  assert.ok(ui.querySelector('button[aria-label="Enable Keyboard rule"]'));
});

it('#6342 names every drawing-rule editing control after the rule name changes', () => {
  useViewerStore.setState({
    customOverrideRules: [{ ...rule, style: { ...rule.style, lineWeight: 0.35 } }],
  });
  const ui = render(<DrawingSettingsPanel />);
  const edit = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes(rule.name));
  assert.ok(edit);
  activate(edit, 'Enter');

  const name = ui.querySelector<HTMLInputElement>('input[aria-label="Rule Name"]');
  assert.ok(name);
  type(name, 'Named drawing rule');
  assert.equal(name.value, 'Named drawing rule');
  assert.equal(name.getAttribute('aria-label'), 'Rule Name');

  for (const label of ['IFC Class', 'Line Weight']) {
    assert.ok(ui.querySelector(`button[aria-label="${label}"]`), `${label} selector is named`);
  }
  for (const label of [
    'Fill color picker', 'Fill color hex value',
    'Stroke color picker', 'Stroke color hex value',
    'Custom line weight in millimeters',
  ]) {
    assert.ok(ui.querySelector(`input[aria-label="${label}"]`), `${label} input is named`);
  }
});
