/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { A2UI_MIME_TYPE, buildSurface } from '@ifc-lite/a2ui';
import { expect, it } from 'vitest';

it('renders server-bound IFC data and relays a row selection through the MCP Apps host', async () => {
  const html = await readFile(new URL('../../../dist/apps/a2ui/app.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  if (!script) throw new Error('Bundled app script missing');
  // The script is the locally built app, and the tool result below is JSON data.
  const window = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const frames: Record<string, unknown>[] = [];
  const parent = { postMessage: (message: Record<string, unknown>) => { frames.push(message); } };
  Object.defineProperty(window, 'parent', { value: parent });
  Object.defineProperty(window, 'localStorage', { get() {
    throw new window.DOMException('Storage is unavailable in an opaque iframe', 'SecurityError');
  } });
  function receive(frame: Record<string, unknown>): void {
    const event = new window.MessageEvent('message', { data: { jsonrpc: '2.0', ...frame } });
    Object.defineProperty(event, 'source', { value: parent });
    window.dispatchEvent(event);
  }
  window.document.write(html.replace(/<script>[\s\S]+<\/script>/, ''));
  try {
    window.eval(script);
    expect(frames[0]).toMatchObject({ method: 'ui/initialize', id: 1 });
    receive({ id: 1, result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} }, hostContext: { theme: 'dark' } } });
    await expect.poll(() => frames.at(-1)?.method).toBe('ui/notifications/initialized');
    expect(window.document.documentElement.dataset.theme).toBe('dark');

    const messages = buildSurface({ surfaceId: 'mcp-app', title: 'IFC facts', sections: [
      { kind: 'stats', items: [{ label: 'Matches', value: 1 }] },
      { kind: 'table', columns: [{ path: 'Name' }], rows: [{ ref: 'model:23', Name: '<b>Door</b>' }] },
      { kind: 'chart', groupBy: 'type', data: [{ label: 'IfcDoor', value: 1, refs: ['model:23'] }] },
      { kind: 'list', refs: ['model:23'] },
      { kind: 'legend', by: 'type', data: [{ label: 'Door color', color: '#1256ab', refs: ['model:23'] }] },
      { kind: 'actions', actions: ['isolate'], refs: ['model:23'] },
      { kind: 'entity', entity: 'model:23' },
      { kind: 'table', columns: [{ path: 'Name' }], query: { types: ['IfcDoor'] } },
      { kind: 'callout', text: 'Computed from IFC' },
    ] });
    receive({ method: 'ui/notifications/tool-result', params: { content: [
      { type: 'resource', resource: { uri: 'ifc-lite://test/result', mimeType: A2UI_MIME_TYPE, text: JSON.stringify(messages) } },
    ] } });
    const { document } = window;
    expect(document.querySelector('h1')?.textContent, document.body.textContent).toBe('IFC facts');
    expect(document.querySelector('dd')?.textContent).toBe('1');
    expect(document.querySelector('main')?.textContent).toContain('computed in the viewer');
    expect(document.querySelector('main')?.textContent).toContain('Open in viewer');
    expect(document.querySelector('main')?.textContent).toContain('Door color');
    expect(document.querySelector('main')?.textContent).toContain('Computed from IFC');
    expect(document.querySelector('svg rect')?.getAttribute('width')).toBe('100');
    const row = document.querySelector('tbody button');
    expect(row?.textContent).toBe('<b>Door</b>');
    expect(row?.querySelector('b')).toBeNull();
    expect(row).toBeInstanceOf(window.HTMLButtonElement);
    if (row instanceof window.HTMLButtonElement) row.click();
    expect(frames.at(-1)).toMatchObject({
      method: 'tools/call', id: 2,
      params: { name: 'a2ui_viewer_action', arguments: { action: 'select', refs: ['model:23'] } },
    });
    receive({ id: 2, result: { content: [{ type: 'text', text: 'Selected 1 entity.' }] } });
    await expect.poll(() => document.querySelector('[role=status]')?.textContent).toBe('Selected 1 entity.');
  } finally {
    receive({ id: 99, method: 'ui/resource-teardown' });
    await window.happyDOM.close();
  }
});
