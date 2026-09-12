/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FileAttachment } from './types.js';
import { collectActiveFileAttachments } from '../attachments.js';
import { buildSystemPrompt } from './system-prompt.js';
import { attachPdfDocument, createDocumentUploadGate } from './document-upload.js';

test('#4177 attaches extracted PDF text at the upload boundary', async () => {
  const added: FileAttachment[] = [];
  const gate = createDocumentUploadGate(async () => '[Page 1]\nFire rating EI60');
  await attachPdfDocument(new File(['pdf'], 'datasheet.pdf', { type: 'application/pdf' }), gate, value => added.push(value));
  assert.equal(added.length, 1);
  assert.equal(added[0].textContent, '[Page 1]\nFire rating EI60');
  const runtimeFiles = collectActiveFileAttachments([], added);
  assert.equal(runtimeFiles[0].textContent, '[Page 1]\nFire rating EI60');
  const prompt = buildSystemPrompt(undefined, runtimeFiles);
  assert.match(prompt, /bim\.files\.text\(name\)/);
  assert.match(prompt, /bim\.mutate\.setProperty/);
  assert.match(prompt, /bim\.export\.ifc/);
});

test('#4177 a late extraction cannot attach after its composer is cancelled', async () => {
  let resolve!: (text: string) => void;
  const gate = createDocumentUploadGate(() => new Promise(done => { resolve = done; }));
  const added: FileAttachment[] = [];
  const pending = attachPdfDocument(new File(['pdf'], 'old.pdf'), gate, value => added.push(value));
  gate.cancel();
  resolve('late text');
  await assert.rejects(pending, /stale/);
  assert.deepEqual(added, []);
});
