/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RoomPanel`'s own chrome reads the i18n catalogue (#4918 zones slice,
 * `zones-panel.en.ts`, `zonesPanel.roomPanel.*`): the no-room empty state,
 * the connected header/status line, the roster (including the
 * `STATUS_META`/`ROLE_META` data-table labels and the "(you)" / selected-
 * count / jump / remove peer controls), and the footer actions. Peer and
 * identity display NAMES are runtime content and are asserted separately
 * from the catalogue keys, not marked by the pseudo-locale.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { PresenceState } from '@ifc-lite/collab';
import { RoomPanel } from './RoomPanel.js';

// `clientId` is not part of the static `PresenceState` shape — it is
// stitched on at runtime by `collabSlice.ts`'s `remotePeers` from the
// awareness map's own key — but `RoomPanel.tsx` reads it back via the same
// `(p as { clientId?: number })` cast the component itself uses, so this
// fixture needs it too to reach the `onKick` (Remove) control.
const PEER_WITH_CLIENT_ID: PresenceState & { clientId: number } = {
  user: { id: 'peer-1', name: 'Peer One', color: '#f00' },
  selection: ['a', 'b'],
  status: 'active',
  lastUpdate: 0,
  role: 'editor',
  camera: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, fov: 50 },
  clientId: 7,
};

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('zonesPanel.roomPanel.')),
);
const KEYS = Object.keys(CATALOGUE) as (keyof typeof CATALOGUE)[];

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}

const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, markValue(CATALOGUE[key]!)]));
const BASELINE_LOCALE = 'en';
const PSEUDO_LOCALE = 'room-panel-pseudo';

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === n.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels, plain text, and (by focusing each button in turn) every
 *  reachable Radix `TooltipContent` string — `RoomPanel` wraps its Jump/
 *  Kick/Revoke controls in `<Tooltip>`, whose content portals outside the
 *  rendered container and only mounts once the trigger has focus. */
function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => button.focus());
    addReadable(document.body, out);
    act(() => button.blur());
  }
  return out;
}

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: Set<string>, afterDom: Set<string>): void {
  for (const occ of occurrences) {
    const english = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      englishDom.has(english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(
        afterDom.has(pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function domAfterPseudo(container: HTMLElement): Set<string> {
  act(() => setLocale(PSEUDO_LOCALE));
  const set = readableStrings(container);
  act(() => setLocale(BASELINE_LOCALE));
  return set;
}

const RESET_STATE = {
  collabRoomId: null,
  collabStatus: 'disconnected' as const,
  collabRole: null,
  collabPeers: [],
  collabSeedPhase: 'none' as const,
  collabSeedProgress: null,
};

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState(RESET_STATE);
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState(RESET_STATE);
});

describe('RoomPanel localization (#4918)', () => {
  it('translates the no-room empty state', () => {
    const container = render(<RoomPanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'zonesPanel.roomPanel.emptyTitle' },
        { key: 'zonesPanel.roomPanel.emptyDescription' },
        { key: 'zonesPanel.roomPanel.createRoomButton' },
        { key: 'zonesPanel.roomPanel.inviteHint' },
      ],
      englishDom,
      afterDom,
    );
  });

  it("translates the connected header, roster's own row, and footer actions", () => {
    useViewerStore.setState({
      collabRoomId: 'room-1',
      collabStatus: 'connected',
      collabRole: 'admin',
      collabIdentity: { id: 'self', name: 'Louis', color: '#888' },
    });
    const container = render(<RoomPanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'zonesPanel.roomPanel.rootAriaLabel' },
        { key: 'zonesPanel.roomPanel.onlyOneHereMessage' },
        { key: 'zonesPanel.roomPanel.copyInviteLinkLabel' },
        { key: 'zonesPanel.roomPanel.revokeLinkLabel' },
        { key: 'zonesPanel.roomPanel.revokeLinkTooltip' },
        { key: 'zonesPanel.roomPanel.leaveRoomLabel' },
        { key: 'zonesPanel.roomPanel.youSuffix' },
        { key: 'zonesPanel.roomPanel.role.admin' },
      ],
      englishDom,
      afterDom,
    );
    // `statusRoom` nests a second `t()` call (the status label) inside its own
    // template, so its pseudo form is checked separately: both the outer
    // template AND the inner status label are marked once the locale switches,
    // not just the outer one.
    const englishStatusRoom = resolve('zonesPanel.roomPanel.statusRoom' as never, {
      status: resolve('zonesPanel.roomPanel.status.live' as never),
    }).trim();
    assert.ok(englishDom.has(englishStatusRoom), 'expected the English status-room line on screen before the locale switch');
    act(() => setLocale(PSEUDO_LOCALE));
    let pseudoStatusRoom: string;
    try {
      pseudoStatusRoom = resolve('zonesPanel.roomPanel.statusRoom' as never, {
        status: resolve('zonesPanel.roomPanel.status.live' as never),
      }).trim();
    } finally {
      act(() => setLocale(BASELINE_LOCALE));
    }
    assert.ok(afterDom.has(pseudoStatusRoom), `expected the status-room line to translate to ${JSON.stringify(pseudoStatusRoom)}`);
    // The identity NAME is runtime content, not a catalogue key.
    assert.ok(englishDom.has('Louis'), 'the identity name must render as-is');
    assert.ok(afterDom.has('Louis'), 'the identity name must not be marked by the pseudo-locale');
  });

  it('translates a peer row\'s selected-count sub-line and jump/remove controls', () => {
    useViewerStore.setState({
      collabRoomId: 'room-1',
      collabStatus: 'connected',
      collabRole: 'admin',
      collabPeers: [PEER_WITH_CLIENT_ID],
    });
    const container = render(<RoomPanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'zonesPanel.roomPanel.selectedCount', params: { count: 2 } },
        { key: 'zonesPanel.roomPanel.jumpToAriaLabel', params: { name: 'Peer One' } },
        { key: 'zonesPanel.roomPanel.jumpToTooltip' },
        { key: 'zonesPanel.roomPanel.removePeerAriaLabel', params: { name: 'Peer One' } },
        { key: 'zonesPanel.roomPanel.removeFromRoomTooltip' },
        { key: 'zonesPanel.roomPanel.role.editor' },
      ],
      englishDom,
      afterDom,
    );
    assert.ok(englishDom.has('Peer One'), 'the peer name must render as-is');
    assert.ok(afterDom.has('Peer One'), 'the peer name must not be marked by the pseudo-locale');
  });
});
