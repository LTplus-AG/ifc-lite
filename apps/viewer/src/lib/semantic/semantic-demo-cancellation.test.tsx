/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { useSemanticPilot, type ValidationExecutor } from './useSemanticPilot';
import { useSemanticSession } from './session';
import { pilotDocument } from './demo';
import type { ValidationOutput } from './validation-job';

const original = useSemanticSession.getState();
afterEach(() => { cleanup(); useSemanticSession.setState(original, true); });

for (const interruption of ['cancel', 'replace'] as const) {
  test(`charter #6643: ${interruption} preserves newer retrieval provenance when an old demo finishes`, async () => {
    let finish: ((value: ValidationOutput) => void) | undefined;
    const execute: ValidationExecutor = () => new Promise(resolve => { finish = resolve; });
    function Harness() {
      const pilot = useSemanticPilot(execute);
      return <><button onClick={() => void pilot.demo(false)}>Demo</button><button onClick={pilot.cancel}>Cancel</button></>;
    }
    const ui = render(<Harness />);
    const buttons = ui.querySelectorAll('button'); click(buttons[0]); assert.ok(finish);
    if (interruption === 'cancel') click(buttons[1]);
    const retrievedAt = '2026-10-02T01:00:00Z';
    const graph = '<urn:newer> <urn:source> "retrieved" .';
    act(() => {
      useSemanticSession.getState().setGraph(graph);
      useSemanticSession.getState().setRetrievedAt(retrievedAt);
    });
    await act(async () => { finish?.({ document: pilotDocument(), graph: 'stale demo', findings: [] }); await Promise.resolve(); });
    assert.equal(useSemanticSession.getState().retrievedAt, retrievedAt);
    assert.equal(useSemanticSession.getState().graph, graph);
  });
}
