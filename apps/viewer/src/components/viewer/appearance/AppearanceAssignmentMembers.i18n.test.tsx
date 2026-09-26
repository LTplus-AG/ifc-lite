/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup, click, render, type } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { DEFAULT_APPEARANCE_SETTINGS } from '@/lib/appearance/settings.js';
import { resolveAppearanceAssignments } from '@/lib/appearance/assignments/resolve.js';
import type { AppearanceAssignment } from '@/lib/appearance/assignments/types.js';
import { AppearanceAssignmentList } from './AppearanceAssignmentList.js';

const TRANSLATED_MEMBERS: Catalogue = {
  'appearanceAssignmentMembers.searchLabel': 'Trouver un objet',
  'appearanceAssignmentMembers.searchPlaceholder': 'Nom ou GlobalId',
  'appearanceAssignmentMembers.groupAriaLabel': 'Objets de cette affectation',
  'appearanceAssignmentMembers.range': '{total} au total : {start} à {end}',
  'appearanceAssignmentMembers.noMatches': 'Aucun objet correspondant',
  'appearanceAssignmentMembers.previousAriaLabel': 'Objets précédents',
  'appearanceAssignmentMembers.previousButton': 'Précédent',
  'appearanceAssignmentMembers.nextAriaLabel': 'Objets suivants',
  'appearanceAssignmentMembers.nextButton': 'Suivant',
};

function assignment(): AppearanceAssignment {
  return {
    id: 'Brick',
    model: { slotId: 'model-slot', modelId: 'model', name: 'Building', sourceSha256: 'a'.repeat(64), revision: 'r' },
    source: { id: 'b'.repeat(64), name: 'Brick', width: 2, height: 2 },
    settings: { ...DEFAULT_APPEARANCE_SETTINGS },
    query: { kind: 'model' },
    members: Array.from({ length: 51 }, (_, index) => ({ expressId: 10 + index, GlobalId: `wall-${index}` })),
    excludedGlobalIds: [],
  };
}

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [rows, setRows] = useState([assignment()]);
  return <AppearanceAssignmentList rows={resolveAppearanceAssignments(rows)} disabled={disabled}
    objectName={(_, expressId) => expressId === 60 ? 'Final wall' : `Object ${expressId}`}
    onMove={() => {}} onRemove={() => {}}
    onExclude={(id, GlobalId, excluded) => setRows(current => current.map(row => row.id === id
      ? { ...row, excludedGlobalIds: excluded ? [...row.excludedGlobalIds, GlobalId]
        : row.excludedGlobalIds.filter(value => value !== GlobalId) }
      : row))} />;
}

function openReview(ui: HTMLElement): void {
  const review = ui.querySelector<HTMLButtonElement>('[aria-label="Review objects for assignment 1"]');
  assert.ok(review);
  click(review);
}

function search(ui: HTMLElement): HTMLInputElement {
  const input = ui.querySelector<HTMLInputElement>('input[type="search"]');
  assert.ok(input);
  return input;
}

function status(ui: HTMLElement): string {
  return ui.querySelector('output')?.textContent ?? '';
}

function checkboxes(ui: HTMLElement): HTMLInputElement[] {
  return [...ui.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

it('renders English member search, range, pagination and accessibility text (#4785)', () => {
  const ui = render(<Harness />);
  openReview(ui);

  const input = search(ui);
  assert.match(input.getAttribute('aria-label') ?? '', /Find an object/);
  assert.equal(input.placeholder, 'Name or GlobalId');
  assert.ok(ui.querySelector('fieldset[aria-label="Objects in this assignment"]'));
  assert.equal(status(ui), '1–50 of 51');
  assert.equal(checkboxes(ui).length, 50);
  const previous = ui.querySelector<HTMLButtonElement>('[aria-label="Previous objects"]');
  const next = ui.querySelector<HTMLButtonElement>('[aria-label="Next objects"]');
  assert.ok(previous && next);
  assert.equal(previous.textContent, 'Previous');
  assert.equal(next.textContent, 'Next');
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);

  click(next);
  assert.equal(status(ui), '51–51 of 51');
  assert.equal(checkboxes(ui).length, 1);
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);
});

it('uses translated controls and a locale-reordered range while paging (#4785)', () => {
  registerLocale('fr', TRANSLATED_MEMBERS);
  setLocale('fr');
  const ui = render(<Harness />);
  openReview(ui);

  assert.match(search(ui).getAttribute('aria-label') ?? '', /Trouver un objet/);
  assert.equal(search(ui).placeholder, 'Nom ou GlobalId');
  assert.ok(ui.querySelector('fieldset[aria-label="Objets de cette affectation"]'));
  assert.equal(status(ui), '51 au total : 1 à 50');
  const next = ui.querySelector<HTMLButtonElement>('[aria-label="Objets suivants"]');
  assert.ok(next);
  assert.equal(next.textContent, 'Suivant');
  click(next);
  assert.equal(status(ui), '51 au total : 51 à 51');
  const previous = ui.querySelector<HTMLButtonElement>('[aria-label="Objets précédents"]');
  assert.ok(previous);
  assert.equal(previous.textContent, 'Précédent');
});

it('searches by object data and GlobalId, then preserves an explicit exclusion (#4785)', () => {
  const ui = render(<Harness />);
  openReview(ui);
  const input = search(ui);

  type(input, 'Final wall');
  assert.equal(checkboxes(ui).length, 1);
  assert.match(checkboxes(ui)[0].parentElement?.textContent ?? '', /Final wall.*wall-50/);
  type(input, 'wall-50');
  assert.equal(checkboxes(ui).length, 1, 'the exact IFC GlobalId remains searchable as data');
  click(checkboxes(ui)[0]);
  assert.equal(checkboxes(ui)[0].checked, false);
  assert.match(ui.querySelector('li')?.textContent ?? '', /1 excluded/);
  assert.match(checkboxes(ui)[0].parentElement?.textContent ?? '', /Final wall.*wall-50/,
    'localization and exclusion do not rewrite object data');
});

it('renders the translated empty state without member or pagination controls (#4785)', () => {
  registerLocale('fr', TRANSLATED_MEMBERS);
  setLocale('fr');
  const ui = render(<Harness />);
  openReview(ui);
  type(search(ui), 'introuvable');

  assert.equal(status(ui), 'Aucun objet correspondant');
  assert.equal(checkboxes(ui).length, 0);
  assert.equal(ui.querySelector('[aria-label="Objets précédents"]'), null);
  assert.equal(ui.querySelector('[aria-label="Objets suivants"]'), null);
});

it('combines a partial locale with exact English fallback messages (#4785)', () => {
  registerLocale('partial-members', {
    'appearanceAssignmentMembers.searchLabel': 'Localized search',
    'appearanceAssignmentMembers.nextButton': 'Localized next',
  });
  setLocale('partial-members');
  const ui = render(<Harness />);
  openReview(ui);

  assert.match(search(ui).getAttribute('aria-label') ?? '', /Localized search/);
  assert.equal(search(ui).placeholder, 'Name or GlobalId');
  assert.equal(status(ui), '1–50 of 51');
  assert.ok(ui.querySelector('fieldset[aria-label="Objects in this assignment"]'));
  assert.equal(ui.querySelector('[aria-label="Next objects"]')?.textContent, 'Localized next');
});

it('updates locale live without losing search, page or exclusion state (#4785)', () => {
  registerLocale('fr', TRANSLATED_MEMBERS);
  const ui = render(<Harness />);
  openReview(ui);
  const input = search(ui);
  type(input, 'wall-');
  const next = ui.querySelector<HTMLButtonElement>('[aria-label="Next objects"]');
  assert.ok(next);
  click(next);
  click(checkboxes(ui)[0]);
  assert.equal(input.value, 'wall-');
  assert.equal(status(ui), '51–51 of 51');
  assert.equal(checkboxes(ui)[0].checked, false);

  act(() => setLocale('fr'));
  assert.equal(search(ui).value, 'wall-');
  assert.equal(status(ui), '51 au total : 51 à 51');
  assert.equal(checkboxes(ui)[0].checked, false);
  assert.match(ui.querySelector('li')?.textContent ?? '', /1 excluded/);
});

it('keeps an expanded translated review disabled after coordinated locking (#4785)', () => {
  registerLocale('fr', TRANSLATED_MEMBERS);
  setLocale('fr');
  function LockingHarness() {
    const [disabled, setDisabled] = useState(false);
    return <><button type="button" aria-label="Lock member review" onClick={() => setDisabled(true)} />
      <Harness disabled={disabled} /></>;
  }
  const ui = render(<LockingHarness />);
  openReview(ui);
  const lock = ui.querySelector('[aria-label="Lock member review"]');
  assert.ok(lock);
  click(lock);

  assert.equal(search(ui).disabled, true);
  assert.ok(checkboxes(ui).every(checkbox => checkbox.disabled));
  assert.ok([...ui.querySelectorAll<HTMLButtonElement>('[aria-label="Objets précédents"], [aria-label="Objets suivants"]')]
    .every(button => button.disabled));
});
