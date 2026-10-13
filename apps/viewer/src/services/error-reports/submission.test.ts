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
