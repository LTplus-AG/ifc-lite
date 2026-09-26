/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { activate, cleanup, render } from '@/test/render.js';
import { GanttTaskTree } from './GanttTaskTree.js';

afterEach(cleanup);

it('#5823 keyboard activation clears the Gantt task selection through the empty-space control', () => {
  function Harness() {
    const [selected, setSelected] = useState(true);
    return <>
      <GanttTaskTree
        rows={[]}
        selectedGlobalIds={selected ? new Set(['task-1']) : new Set()}
        hoveredGlobalId={null}
        onToggleExpand={() => {}}
        onSelect={() => {}}
        onBackgroundClick={() => setSelected(false)}
        onHover={() => {}}
        scrollTop={0}
        onScroll={() => {}}
      />
      <output>{selected ? 'selected' : 'cleared'}</output>
    </>;
  }

  const ui = render(<Harness />);
  const clear = ui.querySelector<HTMLButtonElement>('button[aria-label="Clear task selection"]');
  assert.ok(clear);
  assert.equal(ui.querySelector('output')?.textContent, 'selected');
  activate(clear, 'Enter');
  assert.equal(ui.querySelector('output')?.textContent, 'cleared');
});
