/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ShareDialog`'s own chrome reads the i18n catalogue (#4918 sweep,
 * `misc-panels-b.en.ts`). Same shape as `MergeLayersBanner.i18n.test.tsx`:
 * render with the default (English) locale, then register a partial
 * locale overriding a couple of keys and assert the swap lands while an
 * untranslated key still falls back to English.
 *
 * Two fixture states are exercised: no model loaded (the simplest path —
 * `title`/`description`/`loadModelFirst`), and an already-live, non-admin
 * room (`collabRoomId` + `collabRole: 'viewer'` pre-set so the invite-mint
 * effect's synchronous `isJoiner` branch runs — no network round trip —
 * covering the role picker, link/copy chrome, live-peers label, and the
 * link-expiry notice).
 */
import '@/test/setup-dom.js';
import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { registerLocale, setLocale } from '@/i18n';
import { ShareDialog } from './ShareDialog';

afterEach(() => {
  cleanup();
  setLocale('en');
  act(() => {
    useViewerStore.setState({
      models: new Map(),
      activeModelId: null,
      collabRoomId: null,
      collabRole: null,
      collabRoomModels: new Map(),
    });
  });
});

it('renders the no-model English state by default (#4918)', () => {
  render(<ShareDialog open onOpenChange={() => {}} />);
  assert.ok(document.body.textContent?.includes('Share'));
  assert.ok(document.body.textContent?.includes('Anyone with the link can join — no account needed.'));
  assert.ok(document.body.textContent?.includes('Load a model first, then share it.'));
});

it('translates the no-model state, while an untranslated key falls back to English (#4918)', () => {
  registerLocale('sharedialog-de', {
    'shareDialog.loadModelFirst': 'Zuerst ein Modell laden, dann teilen.',
  });
  act(() => setLocale('sharedialog-de'));
  render(<ShareDialog open onOpenChange={() => {}} />);
  assert.ok(document.body.textContent?.includes('Zuerst ein Modell laden, dann teilen.'));
  // `description` is not in the partial locale: must still fall back.
  assert.ok(document.body.textContent?.includes('Anyone with the link can join — no account needed.'));
});

it('renders the joined-room chrome (role picker, link box, live peers) in English by default (#4918)', () => {
  act(() => {
    useViewerStore.setState({
      models: new Map([['m1', { id: 'm1', name: 'Tower.ifc' } as never]]),
      activeModelId: 'm1',
      collabRoomId: 'room-1',
      collabRole: 'viewer',
      collabRoomModels: new Map([['m1', { modelId: 'm1' } as never]]),
    });
  });
  render(<ShareDialog open onOpenChange={() => {}} />);
  assert.ok(document.body.textContent?.includes('Share “Tower.ifc”'));
  assert.ok(document.body.textContent?.includes('Anyone with the link can'));
  assert.ok(document.body.textContent?.includes('View'));
  assert.ok(document.body.textContent?.includes('Comment'));
  assert.ok(document.body.textContent?.includes('Edit'));
  assert.ok(document.body.textContent?.includes('Link'));
  assert.ok(document.body.textContent?.includes('Only the session admin can create invite links for this session.'));
  assert.ok(document.body.textContent?.includes('Live now'));
  // `role` defaults to 'viewer' (#5599); the notice shows its translated label
  // ('View'), not the raw enum value (#4918 review finding).
  assert.ok(document.body.textContent?.includes('Link expires in 7 days. Anyone with it gets View access.'));
});

it('translates a role label and the joined-room notice, while an untranslated key falls back to English (#4918)', () => {
  registerLocale('sharedialog-fr', {
    'shareDialog.role.viewer.label': 'Voir',
    'shareDialog.onlyAdminCanCreate': "Seul l'administrateur de la salle peut créer des liens d'invitation.",
  });
  act(() => {
    useViewerStore.setState({
      models: new Map([['m1', { id: 'm1', name: 'Tower.ifc' } as never]]),
      activeModelId: 'm1',
      collabRoomId: 'room-1',
      collabRole: 'viewer',
      collabRoomModels: new Map([['m1', { modelId: 'm1' } as never]]),
    });
    setLocale('sharedialog-fr');
  });
  render(<ShareDialog open onOpenChange={() => {}} />);
  assert.ok(document.body.textContent?.includes('Voir'));
  assert.ok(document.body.textContent?.includes("Seul l'administrateur de la salle peut créer des liens d'invitation."));
  // `liveNow` is not in the partial locale: must still fall back.
  assert.ok(document.body.textContent?.includes('Live now'));
});
