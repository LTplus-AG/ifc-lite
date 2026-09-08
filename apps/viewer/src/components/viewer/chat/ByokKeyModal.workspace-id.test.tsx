/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The settings surface for the Anthropic credential.
 *
 * The pinned claims, in the order they were learned the hard way: the workspace
 * box exists on the Anthropic tab and nowhere else; one Save commits BOTH boxes
 * (while they had separate Saves, pasting both and pressing the visible Save
 * stored the key and dropped the id, then the request failed with the very
 * error telling the user to add an id the box was still showing); removing the
 * key removes the id with it; and the toast never describes a write that did
 * not happen.
 *
 * Toast text is read as the delta a click adds to the container: toasts live in
 * a module-global store with no reset and a 3s expiry, so a freshly mounted
 * Toaster replays earlier tests' messages and whole-document assertions pass or
 * fail for unrelated reasons.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, type as typeInto } from '@/test/render.js';
import { getApiKeys, updateApiKeys, clearApiKeys } from '@/services/api-keys';
import { Toaster } from '@/components/ui/toast';
import { ByokKeyModal } from './ByokKeyModal.js';

const WORKSPACE_INPUT = '#byok-anthropic-workspace';
const KEY_INPUT = '#byok-anthropic-input';
const OPENAI_KEY_INPUT = '#byok-openai-input';
/** Long enough for looksLikeProviderKey, which wants 50+ body characters. */
const FAKE_KEY = `sk-ant-api03-${'A'.repeat(60)}`;
const OTHER_KEY = `sk-ant-api03-${'B'.repeat(60)}`;
const FAKE_OPENAI_KEY = `sk-${'C'.repeat(30)}`;

function query<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function buttonWithText(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === text,
  );
  assert.equal(matches.length, 1, `expected exactly one button labelled "${text}"`);
  return matches[0] as HTMLButtonElement;
}

function open(provider: 'anthropic' | 'openai' = 'anthropic'): HTMLElement {
  return render(
    <>
      <ByokKeyModal open onOpenChange={() => undefined} initialProvider={provider} />
      <Toaster />
    </>,
  );
}

/** Text the action adds to the container, which holds only the Toaster. */
function toastFrom(container: HTMLElement, action: () => void): string {
  const before = container.textContent ?? '';
  action();
  const after = container.textContent ?? '';
  assert.ok(after.startsWith(before), 'expected toasts to append, not reorder');
  return after.slice(before.length);
}

describe('ByokKeyModal Anthropic credential', () => {
  beforeEach(() => { clearApiKeys(); });
  afterEach(() => { cleanup(); clearApiKeys(); });

  it('one Save commits the key and the workspace id together', () => {
    // The headline fix. With separate Saves this stored the key, said "saved",
    // and silently discarded the id while leaving it on screen.
    open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, FAKE_KEY);
    typeInto(query<HTMLInputElement>(WORKSPACE_INPUT)!, 'wrkspc_01abc');
    click(buttonWithText('Save'));
    assert.deepEqual(getApiKeys(), {
      anthropicKey: FAKE_KEY,
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('saves a key on its own when no workspace id is involved', () => {
    open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, FAKE_KEY);
    click(buttonWithText('Save'));
    assert.equal(getApiKeys().anthropicKey, FAKE_KEY);
  });

  it('saves an OpenAI key, which has no workspace id at all', () => {
    open('openai');
    typeInto(query<HTMLInputElement>(OPENAI_KEY_INPUT)!, FAKE_OPENAI_KEY);
    click(buttonWithText('Save'));
    assert.equal(getApiKeys().openaiKey, FAKE_OPENAI_KEY);
  });

  it('saves a workspace id on its own, leaving the stored key alone', () => {
    updateApiKeys({ anthropicKey: FAKE_KEY });
    open();
    typeInto(query<HTMLInputElement>(WORKSPACE_INPUT)!, '  wrkspc_01abc  ');
    click(buttonWithText('Save'));
    assert.deepEqual(getApiKeys(), {
      anthropicKey: FAKE_KEY,
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('offers the workspace box on the Anthropic tab and nowhere else', () => {
    open();
    assert.ok(query(WORKSPACE_INPUT), 'expected a workspace id input on the Anthropic tab');
    cleanup();
    open('openai');
    // Assert on a boolean, never the element: node:test serialises the actual
    // value into the failure diff, and a happy-dom node's parent/child cycles
    // turn that into an out-of-memory crash instead of a message.
    assert.ok(
      query(WORKSPACE_INPUT) === null,
      'workspace id field must not render on the OpenAI tab',
    );
  });

  it('shows a workspace id that was already stored', () => {
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_01abc' });
    open();
    assert.equal(query<HTMLInputElement>(WORKSPACE_INPUT)!.value, 'wrkspc_01abc');
  });

  it('replacing the key drops the workspace id and empties the box', () => {
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_01abc' });
    open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, OTHER_KEY);
    click(buttonWithText('Save'));
    assert.equal(getApiKeys().anthropicWorkspaceId, '');
    assert.equal(query<HTMLInputElement>(WORKSPACE_INPUT)!.value, '');
  });

  it('a new key and a new workspace id together keep the typed id', () => {
    // The typed value wins over the clear-on-replace rule; otherwise rotating a
    // key and its workspace in one go silently loses the workspace.
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_old' });
    open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, OTHER_KEY);
    typeInto(query<HTMLInputElement>(WORKSPACE_INPUT)!, 'wrkspc_new');
    click(buttonWithText('Save'));
    assert.deepEqual(getApiKeys(), {
      anthropicKey: OTHER_KEY,
      anthropicWorkspaceId: 'wrkspc_new',
      openaiKey: '',
    });
  });

  it('retyping the SAME workspace id while replacing the key keeps it', () => {
    // Rotating a leaked key inside one workspace, with the user retyping the id
    // to be explicit. Judging "touched" by value equality called that untouched
    // and let clear-on-replace throw the typed value away.
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_01abc' });
    open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, OTHER_KEY);
    const box = query<HTMLInputElement>(WORKSPACE_INPUT)!;
    typeInto(box, 'wrkspc_');
    typeInto(box, 'wrkspc_01abc');
    click(buttonWithText('Save'));
    assert.deepEqual(getApiKeys(), {
      anthropicKey: OTHER_KEY,
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('clearing only the workspace box does not claim a key was saved', () => {
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_01abc' });
    const container = open();
    typeInto(query<HTMLInputElement>(WORKSPACE_INPUT)!, '');
    const said = toastFrom(container, () => click(buttonWithText('Save')));
    assert.equal(getApiKeys().anthropicKey, FAKE_KEY, 'the key must survive');
    assert.equal(getApiKeys().anthropicWorkspaceId, '');
    assert.doesNotMatch(said, /key saved/);
    assert.doesNotMatch(said, /re-enter it/);
    assert.match(said, /Workspace ID cleared/);
  });

  it('re-saving the same key keeps the workspace id', () => {
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_01abc' });
    open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, FAKE_KEY);
    click(buttonWithText('Save'));
    assert.equal(getApiKeys().anthropicWorkspaceId, 'wrkspc_01abc');
  });

  it('refuses a workspace id carrying a paste artifact', () => {
    open();
    typeInto(query<HTMLInputElement>(WORKSPACE_INPUT)!, 'wrkspc_​abc');
    assert.equal(buttonWithText('Save').disabled, true, 'Save must be blocked');
    assert.match(document.body.textContent ?? '', /doesn.t belong in a workspace ID/);
    click(buttonWithText('Save'));
    assert.equal(getApiKeys().anthropicWorkspaceId, '');
  });

  it('removing the key removes the workspace id with it, and says so', () => {
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_01abc' });
    const container = open();
    const said = toastFrom(container, () => click(buttonWithText('Remove')));
    assert.deepEqual(getApiKeys(), { anthropicKey: '', anthropicWorkspaceId: '', openaiKey: '' });
    assert.equal(query<HTMLInputElement>(WORKSPACE_INPUT)!.value, '');
    assert.match(said, /Workspace ID removed/);
  });

  it('removing the OpenAI key leaves the Anthropic credential alone', () => {
    updateApiKeys({
      anthropicKey: FAKE_KEY,
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: FAKE_OPENAI_KEY,
    });
    open('openai');
    click(buttonWithText('Remove'));
    assert.deepEqual(getApiKeys(), {
      anthropicKey: FAKE_KEY,
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('does not announce a cleared workspace id to a user who never had one', () => {
    // The first-time save is the most common path there is. An earlier version
    // computed this from the storage rule rather than the write, and a single
    // deleted guard made it lie here while every test stayed green.
    const container = open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, FAKE_KEY);
    const said = toastFrom(container, () => click(buttonWithText('Save')));
    assert.doesNotMatch(said, /Workspace ID cleared/);
  });

  it('announces the cleared workspace id when a replacement really drops one', () => {
    updateApiKeys({ anthropicKey: FAKE_KEY, anthropicWorkspaceId: 'wrkspc_01abc' });
    const container = open();
    typeInto(query<HTMLInputElement>(KEY_INPUT)!, OTHER_KEY);
    const said = toastFrom(container, () => click(buttonWithText('Save')));
    assert.match(said, /Workspace ID cleared/);
  });
});
