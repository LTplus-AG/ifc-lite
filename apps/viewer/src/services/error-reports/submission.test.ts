/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportClient } from './client';
import { ReportSubmission, type ReviewedReport } from './submission';
const review = (): ReviewedReport => ({ draft: { clientRequestId: crypto.randomUUID(), title: 'View stopped', description: 'After orbiting', visibility: 'private', diagnostics: { errorCode: 'render_error', appVersion: '1', buildSha: 'abc' } }, confidentiality: 'none', publicModelConfirmed: false });

test('#7495 submission retry reuses its reviewed report after a lost submit response', async () => {
  let drafts = 0; let submits = 0;
  const transport: typeof fetch = async (input) => {
    if (String(input).endsWith('/drafts')) { drafts++; return Response.json({ id: 'stable', status: 'draft' }); }
    submits++;
    if (submits === 1) throw new TypeError('Offline');
    return Response.json({ id: 'stable', status: 'submitted' });
  };
  const submission = new ReportSubmission(review(), new ReportClient(transport));
  await assert.rejects(submission.send(new AbortController().signal, () => {}), /Offline/);
  assert.equal((await submission.send(new AbortController().signal, () => {})).id, 'stable');
  assert.equal(drafts, 1); assert.equal(submits, 2);
});

test('#7495 custom NDA requests never upload bytes', async () => {
  const requests: string[] = [];
  const transport: typeof fetch = async input => { requests.push(String(input)); return Response.json({ id: 'stable', status: String(input).endsWith('custom-nda') ? 'manual_review' : 'draft' }); };
  const submission = new ReportSubmission({ ...review(), file: new File(['private'], 'private.ifc'), confidentiality: 'custom', customNdaMessage: 'Private contact' }, new ReportClient(transport));
  assert.equal((await submission.send(new AbortController().signal, () => {})).status, 'manual_review');
  assert.deepEqual(requests, ['/api/reports/drafts', '/api/reports/stable/custom-nda']);
});

test('#7495 cancellation reconciles a lost draft response before deleting the same draft', async () => {
  const bodies: string[] = []; let creates = 0; const deleted: string[] = [];
  const transport: typeof fetch = async (input, options) => {
    if (options?.method === 'DELETE') { deleted.push(String(input)); return new Response(null, { status: 204 }); }
    bodies.push(String(options?.body)); creates++;
    if (creates === 1) throw new TypeError('Response lost');
    return Response.json({ id: 'stable', status: 'draft' });
  };
  const submission = new ReportSubmission(review(), new ReportClient(transport));
  await assert.rejects(submission.send(new AbortController().signal, () => {}), /Response lost/);
  await submission.cancel();
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(deleted, ['/api/reports/stable']);
});

test('#7495 an already queued report never creates a second draft when retried', async () => {
  const requests: string[] = [];
  const transport: typeof fetch = async input => { requests.push(String(input)); return Response.json({ id: 'stable', status: 'submitted' }); };
  const submission = new ReportSubmission(review(), new ReportClient(transport), { id: 'stable', status: 'submitted' });
  assert.equal((await submission.send(new AbortController().signal, () => {})).status, 'submitted');
  assert.deepEqual(requests, ['/api/reports/stable/submit']);
});

test('#7495 public attachment permission must be explicit before any draft or model request', async () => {
  let calls = 0;
  const selected = { ...review(), draft: { ...review().draft, visibility: 'public' as const }, file: new File(['real'], 'project.ifc'), publicModelConfirmed: true };
  const client = new ReportClient(async () => { calls++; throw new Error('Unexpected request'); });
  await assert.rejects(new ReportSubmission(selected, client).send(new AbortController().signal, () => {}), /Review all public/);
  assert.equal(calls, 0);
});

test('#7495 complete public consent authorizes only reviewed model bytes and stays outside the public issue draft', async () => {
  const permission = { version: 'public-model-v1' as const, authorityConfirmed: true as const, redistributionReviewed: true as const,
    confidentialContentReviewed: true as const, downloadedCopiesCannotBeRecalled: true as const, publishDownloadLink: true as const };
  const bodies: { path: string; data: unknown }[] = [];
  const sent: string[] = [];
  const remote = { id: 'upload', status: 'uploading', partBytes: 4, partCount: 1, uploadedParts: [] };
  const client = new ReportClient(async (input, options) => {
    const path = String(input);
    if (options?.method === 'PUT') { sent.push(new TextDecoder().decode(options.body as ArrayBuffer)); return new Response('', { status: 200 }); }
    bodies.push({ path, data: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined });
    if (path.endsWith('/drafts')) return Response.json({ id: 'stable', status: 'draft' });
    if (path.endsWith('/parts')) return Response.json({ url: 'https://fixture.example/part', expiresAt: 'later' });
    if (path.endsWith('/complete')) return Response.json({ ...remote, status: 'ready' });
    if (path.endsWith('/submit')) return Response.json({ id: 'stable', status: 'submitted', publicModel: { state: 'quarantined' } });
    return Response.json(remote);
  });
  const selected = { ...review(), draft: { ...review().draft, visibility: 'public' as const }, file: new File(['real'], 'private-name.ifc'), publicModelConfirmed: true, publicSharingConsent: permission };
  await new ReportSubmission(selected, client).send(new AbortController().signal, () => {});
  assert.deepEqual(sent, ['real']);
  assert.ok(!JSON.stringify(bodies[0]!.data).includes('private-name'));
  assert.ok(!JSON.stringify(bodies[0]!.data).includes('publicSharingConsent'));
  assert.deepEqual((bodies.find(row => row.path.endsWith('/uploads'))!.data as { publicSharingConsent: unknown }).publicSharingConsent, permission);
});
