/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { AutodeskProvider } from '@ifc-lite/source-autodesk';
import type { PluginContext, SourceFile } from '@ifc-lite/plugin-api';
import { SourceResourceDetails } from './SourceResourceDetails.js';
import { useSourceSelection } from './useSourceSelection.js';
import { useState } from 'react';

afterEach(cleanup);
const file: SourceFile = { id: 'file', name: 'House.ifc', containerId: 'folder', currentRevisionId: 'v2' };
const ctx: PluginContext = {
  fetch: async () => { throw new Error('No network'); }, fetchPublic: async () => { throw new Error('No network'); },
  getPreference: async () => undefined, storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
  log: { debug() {}, info() {}, warn() {}, error() {} },
};
function provider() {
  const source = new AutodeskProvider();
  source.listRevisions = async () => ({ items: [
    { id: 'v2', label: '2', createdAt: '2026-01-02' }, { id: 'v1', label: '1', createdAt: '2026-01-01' },
  ] });
  return source;
}
async function open(ui: HTMLElement) {
  const details = ui.querySelector('details')!;
  await act(async () => { details.open = true; details.dispatchEvent(new window.Event('toggle')); await Promise.resolve(); });
}
it('pins a historical version through a catalog update and the actual selection callback', async () => {
  const source = provider(); let selected: SourceFile | undefined;
  function Harness() {
    const [files, setFiles] = useState([file]);
    const selection = useSourceSelection(files, []);
    selected = selection.selectedFiles.get(file.id);
    return <><SourceResourceDetails provider={source} ctx={ctx} projectId="project" file={file}
      selectedFile={selected} busy={false} onSelect={selection.selectRevision} />
      <button onClick={() => setFiles([{ ...file, currentRevisionId: 'v3' }])}>Refresh catalog</button></>;
  }
  const ui = render(<Harness />); await open(ui);
  const historical = [...ui.querySelectorAll('button')].find((b) => b.textContent?.startsWith('1'))!;
  click(historical); assert.equal(selected?.currentRevisionId, 'v1');
  click([...ui.querySelectorAll('button')].find((b) => b.textContent === 'Refresh catalog')!);
  assert.equal(selected?.currentRevisionId, 'v1');
});
it('keeps historical Data Exchange exports unavailable while allowing the current version', async () => {
  const source = provider(); let picked = false;
  const ui = render(<SourceResourceDetails provider={source} ctx={ctx} projectId="project"
    file={{ ...file, kind: 'exchange' }} busy={false} onSelect={() => { picked = true; }} />);
  await open(ui);
  const buttons = [...ui.querySelectorAll('button')];
  const historical = buttons.find((b) => b.textContent?.startsWith('1'))!;
  assert.equal(historical.disabled, true); click(historical); assert.equal(picked, false);
  click(buttons.find((b) => b.textContent?.includes('(current)'))!); assert.equal(picked, true);
});
