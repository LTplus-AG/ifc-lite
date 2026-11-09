/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * C-2 (layer review sibling): "Comment" captures a viewpoint, then posts a
 * topic to the registry. A same-tick double press posts once, and a capture
 * that settles after the section unmounted posts nothing. The real viewport
 * capture runs; only GPU completion is held. Plain-value assertions only.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render, type, waitFor } from '@/test/render.js';
import { installHeldCapture, type HeldCapture } from '@/test/bcf-held-capture.js';
import type { LayerRegistryClient, RegistryReviewSummary } from '@/lib/layers/registry-client';
import { LayerReviewSection } from './LayerReviewSection.js';

const REVIEW: RegistryReviewSummary = {
  id: 'review-1', layerId: 'candidate-1', into: 'main', reviewers: [], status: 'open', openedAt: '2026-01-01T00:00:00.000Z', topics: [],
};

let capture: HeldCapture;
let posts = 0;
const client = {
  listReviews: async () => ({ reviews: [REVIEW] }),
  postTopic: async () => { posts += 1; return {}; },
} as unknown as LayerRegistryClient;

beforeEach(() => {
  posts = 0;
  capture = installHeldCapture();
  useViewerStore.setState({ layerStackPathToId: new Map([['2O2Fr$t4X7Zf8NOew3FLOH', 7]]), selectedEntityId: 7, selectedEntityIds: new Set([7]) });
});
afterEach(() => { cleanup(); capture.dispose(); mock.restoreAll(); document.body.innerHTML = ''; });

async function readyToComment(): Promise<HTMLButtonElement> {
  render(<LayerReviewSection client={client} candidateId="candidate-1" refName="main" />);
  await waitFor(() => document.body.querySelector('input[aria-label="Review comment title"]') !== null, 'the review loaded');
  const title = document.body.querySelector<HTMLInputElement>('input[aria-label="Review comment title"]');
  assert.ok(title, 'title input');
  type(title, 'Check this wall');
  const comment = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Comment');
  assert.ok(comment, 'Comment button');
  assert.equal(comment.disabled, false);
  return comment;
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });

test('C-2 layer review: a double-pressed Comment captures one viewpoint and posts one topic', async () => {
  const comment = await readyToComment();
  act(() => {
    comment.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    comment.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  capture.releaseAll();
  await waitFor(() => posts > 0, 'the topic is posted');
  await settle();
  assert.equal(capture.frames(), 1, 'the refused second press never captured a viewpoint');
  assert.equal(posts, 1);
});

test('C-2 layer review: a capture that settles after the section unmounted posts nothing', async () => {
  const comment = await readyToComment();
  act(() => { comment.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await waitFor(() => capture.frames() === 1, 'the viewpoint is capturing');
  cleanup();
  capture.releaseAll();
  await settle();
  assert.equal(posts, 0);
});

test('C-2 layer review: a viewpoint capture that resolves null toasts once and posts nothing', async () => {
  const { toast } = await import('@/components/ui/toast');
  const errors = mock.method(toast, 'error', () => undefined);
  mock.method(console, 'error', () => undefined);
  mock.method(console, 'warn', () => undefined);
  const comment = await readyToComment();
  capture.unplug();
  act(() => { comment.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await settle();
  assert.equal(errors.mock.callCount(), 1, 'reported once, not as a raw destructuring error');
  assert.equal(String(errors.mock.calls[0]?.arguments[0]).includes('destructure'), false);
  assert.equal(posts, 0);
});

// C-1: the parent reuses this section when the selected candidate changes.
test('C-1 candidate replacement hides the old review and ignores its late refresh', async () => {
  let select!: (id: string) => void;
  let finish!: (value: { reviews: RegistryReviewSummary[] }) => void;
  let calls = 0;
  const switchingClient = { ...client, listReviews: () => {
    calls++;
    if (calls === 2) return new Promise<{ reviews: RegistryReviewSummary[] }>(resolve => { finish = resolve; });
    return Promise.resolve({ reviews: [REVIEW] });
  } } as unknown as LayerRegistryClient;
  function Host() {
    const [id, setId] = useState('candidate-1'); select = setId;
    return <LayerReviewSection client={switchingClient} candidateId={id} refName="main" />;
  }
  render(<Host />);
  await waitFor(() => document.body.querySelector('input[aria-label="Review comment title"]') !== null, 'A review loaded');
  const refresh = document.body.querySelector<HTMLButtonElement>('button[aria-label="Refresh review"]');
  assert.equal(Boolean(refresh), true);
  act(() => refresh!.click());
  act(() => select('candidate-2'));
  assert.equal(document.body.querySelectorAll('input[aria-label="Review comment title"]').length, 0, 'B cannot post to A while loading');
  await act(async () => { finish({ reviews: [REVIEW] }); });
  assert.equal(document.body.querySelectorAll('input[aria-label="Review comment title"]').length, 0, 'late A refresh cannot restore A');
});

for (const phase of ['push', 'open'] as const) test(`C-1 retiring a review during ${phase} prevents the next registry operation`, async () => {
  const { getBrowserLayerStore } = await import('@/lib/layers/browser-store');
  const store = await getBrowserLayerStore();
  const { computeLayerId } = await import('@ifc-lite/ifcx');
  const file = { header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 'fixture', timestamp: '2026-01-01T00:00:00Z' }, imports: [], schemas: {}, data: [] };
  const id = computeLayerId(file);
  store.storeLayer({ ...file, header: { ...file.header, id } });
  let finish!: () => void;
  let waiting = false, reads = 0, opens = 0;
  const hold = () => new Promise<void>(resolve => { waiting = true; finish = resolve; });
  const registry = {
    listReviews: async () => { reads++; return { reviews: [] }; },
    pushLayer: async () => { if (phase === 'push') await hold(); return { id }; },
    openReview: async () => { opens++; if (phase === 'open') await hold(); return { id: 'opened' }; },
  } as unknown as LayerRegistryClient;
  let select!: (id: string) => void;
  function Host() { const [candidate, setCandidate] = useState(id); select = setCandidate; return <LayerReviewSection client={registry} candidateId={candidate} refName="main" />; }
  render(<Host />);
  await waitFor(() => reads === 1, 'initial review read');
  const open = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Open review');
  assert.equal(Boolean(open), true);
  act(() => open!.click());
  await waitFor(() => waiting, 'registry operation is pending');
  act(() => select('replacement'));
  await waitFor(() => reads === 2, 'replacement review read');
  await act(async () => finish()); await settle();
  assert.equal(opens, phase === 'push' ? 0 : 1, 'retired push cannot open a review');
  assert.equal(reads, 2, 'retired open cannot refresh the old candidate');
});

for (const phase of ['post', 'refresh'] as const) test(`C-1 retiring a comment during ${phase} performs no stale follow-up`, async () => {
  const { toast } = await import('@/components/ui/toast');
  const success = mock.method(toast, 'success', () => undefined);
  let reads = 0, pending = false;
  let finish!: () => void;
  const hold = () => new Promise<void>(resolve => { pending = true; finish = resolve; });
  mock.method(client, 'listReviews', async () => { reads++; if (phase === 'refresh' && reads === 2) await hold(); return { reviews: [REVIEW] }; });
  mock.method(client, 'postTopic', async () => { if (phase === 'post') await hold(); return { guid: 'posted' }; });
  const comment = await readyToComment();
  act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  act(() => comment.click());
  await waitFor(() => pending, 'comment operation is pending');
  cleanup();
  await act(async () => finish()); await settle();
  assert.equal(reads, phase === 'post' ? 1 : 2, 'an abandoned post does not refresh');
  assert.equal(success.mock.callCount(), 0, 'an abandoned refresh does not toast');
});
