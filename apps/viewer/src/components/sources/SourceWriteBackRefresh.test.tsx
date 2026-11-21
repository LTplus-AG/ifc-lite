/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useCallback, useState } from 'react';
import { cleanup, click, render } from '@/test/render';
import { notifySourceWriteBackSaved } from '@/services/sources/source-writeback-command';
import { useSourceWriteBackRefresh } from './useSourceWriteBackRefresh';

afterEach(cleanup);
it('#9522 refreshes only the matching source, after its in-progress download finishes',()=>{
  function Harness(){
    const [busy,setBusy]=useState(true),[refreshes,setRefreshes]=useState(0);
    const refresh=useCallback(()=>setRefreshes(count=>count+1),[]);
    useSourceWriteBackRefresh({providerId:'provider',projectId:'project',busy,onRefresh:refresh});
    return <><output>{refreshes}</output><button onClick={()=>setBusy(false)}>Finish download</button></>;
  }
  const ui=render(<Harness />);
  act(()=>notifySourceWriteBackSaved('other','project'));assert.equal(ui.querySelector('output')?.textContent,'0');
  act(()=>notifySourceWriteBackSaved('provider','project'));assert.equal(ui.querySelector('output')?.textContent,'0');
  click(ui.querySelector('button')!);assert.equal(ui.querySelector('output')?.textContent,'1');
  act(()=>notifySourceWriteBackSaved('provider','other-project'));assert.equal(ui.querySelector('output')?.textContent,'1');
  act(()=>notifySourceWriteBackSaved('provider','project'));assert.equal(ui.querySelector('output')?.textContent,'2');
});
