/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DownloadJobs } from '../src/download-jobs.js';
import { CloudSessions } from '../src/sessions.js';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), 'ifclite-download-jobs-')); roots.push(root);
  const sessions = new CloudSessions({ origin: 'https://viewer.example', apps: {}, downloadDirectory: root, fetch: fetcher });
  await sessions.downloads.ready;
  const owner = sessions.create('dropbox'); owner.identity = { id: 'user' }; owner.token = { access: 'fixture-token', expires: Date.now() + 3600_000 };
  return { root, sessions, owner, jobs: new DownloadJobs(sessions) };
}
const model = 'ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;';
it('returns a job before a download exceeds the 120-second edge limit, then claims exact bytes once (#6840)', async () => {
  vi.useFakeTimers(); let release: ((response: Response) => void) | undefined;
  const f = await fixture(async () => new Promise<Response>(resolve => { release = resolve; }));
  try {
    const id = f.jobs.start(f.owner, { path: 'rev:fixture' });
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(f.jobs.status(f.owner, id).state).toBe('preparing');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(f.jobs.status(f.owner, id).state).toBe('preparing');
    release?.(new Response(model));
    await vi.waitFor(() => expect(f.jobs.status(f.owner, id).state).toBe('ready'));
    const response = f.jobs.claim(f.owner, id, new AbortController().signal);
    expect(() => f.jobs.claim(f.owner, id, new AbortController().signal)).toThrow('expired');
    expect(await response.text()).toBe(model); expect(await readdir(f.root)).toEqual([]);
  } finally { await f.sessions.close(); }
});
it('keeps cancelled preparation capacity until ignored upstream cancellation actually settles (#6840)', async () => {
  const releases: ((response: Response) => void)[] = [];
  const f = await fixture(async () => new Promise<Response>(resolve => releases.push(resolve)));
  try {
    const first = f.jobs.start(f.owner, { path: 'rev:first' }); f.jobs.start(f.owner, { path: 'rev:second' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    f.jobs.cancel(f.owner, first);
    expect(() => f.jobs.start(f.owner, { path: 'rev:third' })).toThrow('busy');
    releases[0](new Response(model));
    let third: string | undefined;
    await vi.waitFor(() => { third = f.jobs.start(f.owner, { path: 'rev:third' }); });
    expect(third).toBeTruthy();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1](new Response(model)); releases[2](new Response(model));
  } finally { await f.sessions.close(); }
  expect(await readdir(f.root)).toEqual([]);
});
it('isolates job status, cancellation and artifact claims by session and cleans ready artifacts on signout (#6840)', async () => {
  const f = await fixture(async () => new Response(model));
  try {
    const id = f.jobs.start(f.owner, { path: 'rev:fixture' }); const other = f.sessions.create('dropbox');
    await vi.waitFor(() => expect(f.jobs.status(f.owner, id).state).toBe('ready'));
    expect(() => f.jobs.status(other, id)).toThrow('expired');
    expect(() => f.jobs.claim(other, id, new AbortController().signal)).toThrow('expired');
    f.jobs.cancel(other, id); expect(f.jobs.status(f.owner, id).state).toBe('ready');
    f.sessions.discard(f.owner);
    await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]));
  } finally { await f.sessions.close(); }
});
it('expires unclaimed artifacts after two minutes and releases download slots (#6840)', async () => {
  vi.useFakeTimers(); const f = await fixture(async () => new Response(model));
  try {
    const ids = [f.jobs.start(f.owner, { path: 'rev:a' }), f.jobs.start(f.owner, { path: 'rev:b' })];
    await vi.waitFor(() => ids.forEach(id => expect(f.jobs.status(f.owner, id).state).toBe('ready')));
    expect(() => f.jobs.start(f.owner, { path: 'rev:c' })).toThrow('busy');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(() => f.jobs.status(f.owner, ids[0])).toThrow('expired');
    await vi.waitFor(async () => expect(await readdir(f.root)).toEqual([]));
    expect(f.jobs.start(f.owner, { path: 'rev:c' })).toBeTruthy();
  } finally { await f.sessions.close(); }
});
it('shutdown aborts preparation and waits for cleanup rather than leaving a background transfer (#6840)', async () => {
  let observed: AbortSignal | null | undefined;
  const f = await fixture(async (_input, init) => {
    observed = init?.signal;
    return new Promise<Response>((_resolve, reject) => observed?.addEventListener('abort', () => reject(observed?.reason), { once: true }));
  });
  f.jobs.start(f.owner, { path: 'rev:fixture' });
  await vi.waitFor(() => expect(observed).toBeTruthy());
  await f.sessions.close(); expect(observed?.aborted).toBe(true); expect(await readdir(f.root)).toEqual([]);
});
