/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { createAutodeskService } from '@ifc-lite/source-autodesk';
import type { NativeArtifactAdapter } from '../src/config.js';
import { harness, login, origin } from './handler-fixture.js';

const ref = { projectId: `adsk1:${encodeURIComponent(JSON.stringify({ kind: 'site', project: 'project', id: 'site', region: 'EMEA' }))}`,
  containerId: 'folder', fileId: 'file', revisionId: 'version' };
async function client(adapter: NativeArtifactAdapter, onStatus?: () => void) {
  const { handler } = harness({ adapters: [adapter] });
  const auth = await login(handler);
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers); headers.set('cookie', auth.cookie); headers.set('origin', origin);
    const path = String(input); calls.push(path);
    const response = await handler(new Request(new URL(path, origin), { ...init, headers }));
    if (/\/imports\/[^/]+$/.test(path)) onStatus?.();
    return response;
  };
  return { service: createAutodeskService(transport), calls };
}
describe('browser client and session-owned import protocol', () => {
  it('loads only the pinned artifact after a preparing job and announces download', async () => {
    const adapter: NativeArtifactAdapter = { kind: 'proposal', convert: async () => ({
      revisionId: 'version', format: 'ifcx', bytes: new TextEncoder().encode('native-artifact'),
    }) };
    const c = await client(adapter); const phases: string[] = [];
    const bytes = await c.service.importResource(ref, 'EMEA', { onPhase: (phase) => phases.push(phase) });
    expect(new TextDecoder().decode(bytes)).toBe('native-artifact');
    expect(phases).toEqual(['preparing', 'downloading']);
    expect(c.calls.some((path) => path.endsWith('/artifact'))).toBe(true);
    expect(c.calls.some((path) => path.endsWith('/cancel'))).toBe(false);
  });
  it('cancels the owned server job when the user aborts polling', async () => {
    let statusRead!: () => void; const status = new Promise<void>((resolve) => { statusRead = resolve; });
    let aborted!: () => void; const stopped = new Promise<void>((resolve) => { aborted = resolve; });
    const adapter: NativeArtifactAdapter = { kind: 'proposal', convert: async ({ signal }) => {
      return new Promise<Awaited<ReturnType<NativeArtifactAdapter['convert']>>>((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true });
        if (signal.aborted) { aborted(); reject(signal.reason); }
      });
    } };
    const c = await client(adapter, statusRead); const controller = new AbortController();
    const pending = c.service.importResource(ref, 'EMEA', { signal: controller.signal });
    await status; controller.abort();
    await expect(pending).rejects.toThrow(); await stopped;
    expect(c.calls.some((path) => path.endsWith('/cancel'))).toBe(true);
    expect(c.calls.some((path) => path.endsWith('/artifact'))).toBe(false);
  });
});
