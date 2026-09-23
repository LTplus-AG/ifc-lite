/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup, render } from '@/test/render.js';
import { dispatch, parsePlaygroundModel, type LoadedPlaygroundModel } from './playground-dispatcher.js';

afterEach(cleanup);

it('Playground sidebar count and type rows refresh after real live entity edits (#5249)', async () => {
  const source = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', "#1=IFCWALL('0SummaryWall0000000000',$,'Source wall',$,$,$,$,$,.STANDARD.);",
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(source);
  const model = await parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'summary.ifc');
  let changeNotifications = 0;
  let refresh = () => {};
  const notify = () => { changeNotifications++; refresh(); };
  const created = await dispatch(model, 'entity_create', {
    type: 'IfcDoor', attributes: ['0SummaryDoor0000000000', null, 'Authored door'],
  }, { onModelChanged: notify });
  assert.equal(created.isError, false, created.text);
  assert.equal(changeNotifications, 1, 'a successful mutation must notify the sidebar');

  const { ModelSummary } = await import('./playground-model-summary.js');
  function Harness({ current }: { current: LoadedPlaygroundModel }) {
    const [revision, setRevision] = useState(0);
    refresh = () => setRevision((value) => value + 1);
    return <ModelSummary model={current} revision={revision} />;
  }

  const ui = render(<Harness current={model} />);
  const entityCount = () => Number(ui.querySelectorAll('dd')[1]?.textContent?.replaceAll(',', ''));
  assert.equal(entityCount(), 2);
  assert.match(ui.textContent ?? '', /IfcWall/);
  assert.match(ui.textContent ?? '', /IfcDoor/);

  await act(async () => {
    const deleted = await dispatch(model, 'entity_delete', { express_id: 1 }, { onModelChanged: notify });
    assert.equal(deleted.isError, false, deleted.text);
  });
  assert.equal(changeNotifications, 2);
  assert.equal(entityCount(), 1);
  assert.doesNotMatch(ui.textContent ?? '', /IfcWall/);
  assert.match(ui.textContent ?? '', /IfcDoor/);

  await act(async () => {
    const batch = await dispatch(model, 'mutation_batch', {
      operations: [{ tool: 'entity_create', args: {
        type: 'IfcWindow', attributes: ['0SummaryWindow00000000', null, 'Authored window'],
      } }],
    }, { onModelChanged: notify });
    assert.equal(batch.isError, false, batch.text);
  });
  assert.equal(changeNotifications, 3);
  assert.equal(entityCount(), 2);
  assert.match(ui.textContent ?? '', /IfcWindow/);
});
