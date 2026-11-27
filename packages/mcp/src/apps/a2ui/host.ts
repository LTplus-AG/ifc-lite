/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CallToolResult } from '../../protocol/types.js';
import { SURFACE_ACTION_TOOL, type SurfaceAction } from './constants.js';

const PROTOCOL_VERSION = '2026-01-26';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** MCP Apps view-side protocol, via the immediate parent (host or sandbox proxy). */
export function connectHost(onResult: (result: CallToolResult) => void, report: (message: string) => void) {
  let nextId = 0;
  let ready = false;
  let serverTools = false;
  let closed = false;
  const pending = new Map<number, (frame: Record<string, unknown>) => void>();
  const send = (frame: Record<string, unknown>) => window.parent.postMessage({ jsonrpc: '2.0', ...frame }, '*');
  const notify = (method: string, params?: Record<string, unknown>) => send({ method, ...(params && { params }) });

  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The MCP Apps host did not respond.'));
      }, 15_000);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        if (frame.error) reject(new Error(String(record(frame.error).message ?? 'The host rejected the request.')));
        else resolve(frame.result);
      });
      send({ id, method, params });
    });
  }

  function theme(context: Record<string, unknown>): void {
    if (context.theme === 'dark' || context.theme === 'light') document.documentElement.dataset.theme = context.theme;
  }

  let lastWidth = 0;
  let lastHeight = 0;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const bounds = document.body.getBoundingClientRect();
    const width = Math.ceil(bounds.width);
    const height = Math.ceil(bounds.height);
    if (ready && (width !== lastWidth || height !== lastHeight)) {
      lastWidth = width;
      lastHeight = height;
      notify('ui/notifications/size-changed', { width, height });
    }
  }) : undefined;

  function receive(event: MessageEvent<unknown>): void {
    // The app may have an opaque origin, and the parent may be a sandbox proxy.
    if (event.source !== window.parent) return;
    const frame = record(event.data);
    if (frame.jsonrpc !== '2.0') return;
    if (frame.method === 'ping' || frame.method === 'ui/resource-teardown') {
      if (typeof frame.id === 'string' || typeof frame.id === 'number') send({ id: frame.id, result: {} });
      if (frame.method === 'ui/resource-teardown') {
        closed = true;
        observer?.disconnect();
        window.removeEventListener('message', receive);
        for (const complete of pending.values()) complete({ error: { message: 'The app closed.' } });
        pending.clear();
      }
      return;
    }
    if (frame.method === undefined && typeof frame.id === 'number') {
      const complete = pending.get(frame.id);
      pending.delete(frame.id);
      complete?.(frame);
      return;
    }
    if (!ready) return;
    if (frame.method === 'ui/notifications/tool-result') {
      const result = record(frame.params);
      if (Array.isArray(result.content)) onResult(result as unknown as CallToolResult);
    }
    if (frame.method === 'ui/notifications/host-context-changed') theme(record(frame.params));
    if (frame.method === 'ui/notifications/tool-cancelled') report('The tool call was cancelled.');
  }

  if (window.parent !== window) {
    window.addEventListener('message', receive);
    void request('ui/initialize', {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: { name: 'ifc-lite A2UI surface', version: '1.0.0' },
      appCapabilities: { availableDisplayModes: ['inline'] },
    }).then((response) => {
      if (closed) return;
      const result = record(response);
      if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error('This MCP Apps protocol version is unsupported.');
      theme(record(result.hostContext));
      serverTools = 'serverTools' in record(result.hostCapabilities);
      ready = true;
      notify('ui/notifications/initialized');
      observer?.observe(document.body);
    }).catch((err: Error) => { if (!closed) report(err.message); });
  }

  return async (action: SurfaceAction, refs: string[], color?: string): Promise<void> => {
    if (!ready || closed || !serverTools) {
      report('The MCP Apps host does not expose viewer actions.');
      return;
    }
    try {
      const result = await request('tools/call', {
        name: SURFACE_ACTION_TOOL, arguments: { action, refs, ...(color === undefined ? {} : { color }) },
      }) as CallToolResult;
      report(result.content.find((item) => item.type === 'text')?.text ?? '');
    } catch (err) {
      if (!closed) report(err instanceof Error ? err.message : String(err));
    }
  };
}
