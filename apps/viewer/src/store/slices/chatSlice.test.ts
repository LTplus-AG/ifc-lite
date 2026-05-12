/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorFeedbackContent } from './chatSlice.js';
import { create } from 'zustand';
import { createChatSlice, type ChatSlice } from './chatSlice.js';
import { createPatchDiagnostic, createPreflightDiagnostic } from '../../lib/llm/script-diagnostics.js';
import { DEFAULT_FREE_MODEL, DEFAULT_BYOK_MODEL } from '../../lib/llm/models.js';

function withMockLocalStorage(fn: () => void) {
  const original = globalThis.localStorage;
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  try {
    fn();
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: original,
    });
  }
}

test('buildErrorFeedbackContent includes revision and diagnostics for patch conflicts', () => {
  const prompt = buildErrorFeedbackContent(
    'const width = 30;',
    'Edit op "declare-width-depth" targets revision 3, but expected base revision is 4.',
    {
      currentRevision: 4,
      reason: 'patch-conflict',
      diagnostics: [
        createPatchDiagnostic(
          'patch_revision_conflict',
          'Edit op "declare-width-depth" targets revision 3, but expected base revision is 4.',
          'error',
          { attemptedOpIds: ['declare-width-depth'], opBaseRevision: 3, currentEditorRevision: 4 },
        ),
      ],
    },
  );

  assert.match(prompt, /Failure type: patch-conflict/);
  assert.match(prompt, /Current script revision: 4/);
  assert.match(prompt, /Return exactly one `ifc-script-edits` block/);
  assert.match(prompt, /Use exact SEARCH\/REPLACE blocks inside that fence/);
  assert.match(prompt, /The script needs a root-cause repair\./);
  assert.match(prompt, /\[patch:patch_revision_conflict\]/);
  assert.match(prompt, /copy SEARCH blocks from that latest revision/);
});

test('buildErrorFeedbackContent includes structured preflight diagnostics', () => {
  const prompt = buildErrorFeedbackContent(
    'bim.create.addIfcPlate(h, storey, { Width: 2, Height: 3, Thickness: 0.1 });',
    'Preflight validation failed.',
    {
      reason: 'preflight',
      diagnostics: [
        createPreflightDiagnostic(
          'create_contract',
          '`bim.create.addIfcPlate(...)` uses `Depth` and `Thickness`, not `Height`.',
        ),
      ],
    },
  );

  assert.match(prompt, /\[preflight:create_contract\]/);
  assert.match(prompt, /current script that should be repaired in place/i);
});

test('buildErrorFeedbackContent surfaces grouped root cause evidence when diagnostics include ranges', () => {
  const prompt = buildErrorFeedbackContent(
    'const script = true;',
    'Preflight validation failed.',
    {
      reason: 'preflight',
      diagnostics: [
        createPreflightDiagnostic(
          'wall_hosted_opening_pattern',
          'Suspicious pattern: `bim.create.addIfcDoor(...)`...',
          'error',
          {
            methodName: 'addIfcDoor',
            range: { from: 120, to: 180 },
            snippet: 'bim.create.addIfcDoor(h, ground, { Name: "Front Door" });',
          },
        ),
      ],
    },
  );

  assert.match(prompt, /Root cause to fix first:/);
  assert.match(prompt, /key: placement_context_mismatch/);
  assert.match(prompt, /scope: block/);
  assert.match(prompt, /Supporting evidence:/);
  assert.match(prompt, /method=addIfcDoor/);
  assert.match(prompt, /range=120\.\.180/);
  assert.match(prompt, /Front Door/);
});

test('buildErrorFeedbackContent reinforces preservation rules for patch apply failures', () => {
  const prompt = buildErrorFeedbackContent(
    'const h = bim.create.project({ Name: "Tower" });',
    'Repair turns cannot use `replaceAll` unless the system explicitly allows a full rewrite.',
    {
      reason: 'patch-apply',
      currentRevision: 9,
      diagnostics: [
        createPatchDiagnostic(
          'unsafe_full_replacement',
          'Repair turns cannot use `replaceAll` unless the system explicitly allows a full rewrite.',
        ),
      ],
    },
  );

  assert.match(prompt, /Failure type: patch-apply/);
  assert.match(prompt, /Do NOT use `replaceAll` unless the user explicitly asked to regenerate the full script/);
  assert.match(prompt, /Use exact SEARCH\/REPLACE blocks inside that fence/);
  assert.match(prompt, /Copy SEARCH text verbatim from the CURRENT script/);
  assert.match(prompt, /keep the full script intact and patch only the necessary regions/);
  assert.doesNotMatch(prompt, /Provide a corrected version/);
});

test('buildErrorFeedbackContent can include live selection and stale code block context', () => {
  const prompt = buildErrorFeedbackContent(
    'const live = true;',
    'ReferenceError: width is not defined',
    {
      currentRevision: 5,
      currentSelection: { from: 6, to: 10 },
      staleCodeBlock: 'const width = 30;',
      diagnostics: [
        createPatchDiagnostic(
          'patch_semantic_error',
          'Malformed repair reply mixed a js fence with edit ops.',
          'error',
          { failureKind: 'parse_error', fixHint: 'Return one patch block only.' },
        ),
      ],
    },
  );

  assert.match(prompt, /Current selection: from=6, to=10/);
  assert.match(prompt, /it may be stale relative to the editor/);
  assert.match(prompt, /failure=parse_error/);
  assert.match(prompt, /Hint: Return one patch block only\./);
});

test('buildErrorFeedbackContent groups multiple local diagnostics under one root cause', () => {
  const prompt = buildErrorFeedbackContent(
    'const h = bim.create.project({ Name: "House" });',
    'Preflight validation failed.',
    {
      reason: 'preflight',
      diagnostics: [
        createPreflightDiagnostic(
          'wall_hosted_opening_pattern',
          'Suspicious door call.',
          'error',
          {
            methodName: 'addIfcDoor',
            range: { from: 10, to: 20 },
            snippet: 'bim.create.addIfcDoor(...)',
          },
        ),
        createPreflightDiagnostic(
          'world_placement_elevation',
          'Suspicious repeated world placement.',
          'error',
          {
            methodName: 'addIfcMember',
            range: { from: 30, to: 40 },
            snippet: 'bim.create.addIfcMember(...)',
          },
        ),
      ],
    },
  );

  assert.equal((prompt.match(/\[root-cause:placement_context_mismatch\]/g) ?? []).length, 1);
  assert.match(prompt, /scope=block/);
  assert.match(prompt, /supporting evidence: preflight:wall_hosted_opening_pattern/);
  assert.match(prompt, /supporting evidence: preflight:world_placement_elevation/);
});

test('clearChatMessages resets streaming state as well as persisted messages', () => {
  const useChatStore = create<ChatSlice>()((...args) => createChatSlice(...args));
  const abortController = new AbortController();

  useChatStore.getState().addChatMessage({
    id: '1',
    role: 'user',
    content: 'Create a house',
    createdAt: Date.now(),
  });
  useChatStore.getState().setChatStatus('streaming');
  useChatStore.getState().setChatStreamingContent('partial');
  useChatStore.getState().setChatAbortController(abortController);

  useChatStore.getState().clearChatMessages();

  assert.deepEqual(useChatStore.getState().chatMessages, []);
  assert.equal(useChatStore.getState().chatStatus, 'idle');
  assert.equal(useChatStore.getState().chatStreamingContent, '');
  assert.equal(useChatStore.getState().chatAbortController, null);
  assert.equal(abortController.signal.aborted, true);
  assert.deepEqual(useChatStore.getState().chatAttachments, []);
});

test('setChatHasByokKey falls back to a free model when keys are removed', () => {
  const useChatStore = create<ChatSlice>()((...args) => createChatSlice(...args));
  useChatStore.getState().setChatHasByokKey(true);
  useChatStore.getState().setChatActiveModel(DEFAULT_BYOK_MODEL.id);

  useChatStore.getState().setChatHasByokKey(false);

  assert.equal(useChatStore.getState().chatHasByokKey, false);
  assert.equal(useChatStore.getState().chatActiveModel, DEFAULT_FREE_MODEL.id);
});

test('removeChatAttachment only removes the targeted attachment id', () => {
  const useChatStore = create<ChatSlice>()((...args) => createChatSlice(...args));
  useChatStore.getState().addChatAttachment({
    id: 'a-1',
    name: 'duplicate.csv',
    type: 'text/csv',
    size: 12,
    textContent: 'a,b\n1,2',
  });
  useChatStore.getState().addChatAttachment({
    id: 'a-2',
    name: 'duplicate.csv',
    type: 'text/csv',
    size: 12,
    textContent: 'a,b\n3,4',
  });

  useChatStore.getState().removeChatAttachment('a-1');

  assert.deepEqual(
    useChatStore.getState().chatAttachments.map((attachment) => attachment.id),
    ['a-2'],
  );
});

