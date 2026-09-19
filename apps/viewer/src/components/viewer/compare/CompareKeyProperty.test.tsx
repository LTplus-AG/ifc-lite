/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Compare panel's "Key on" control (issue #4989): typing an invalid spec
 * shows an inline note and never applies (the store keeps its last-applied
 * value); a valid `Tag`/`Pset.Property` spec commits on blur/Enter/clear —
 * never per keystroke, since a commit re-runs the whole comparison; the
 * duplicate-authored-key note renders whenever the caller has one to show.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, blur, press, type as typeInto } from '@/test/render.js';
import { CompareKeyProperty } from './CompareKeyProperty.js';

afterEach(cleanup);

function input(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[type="text"]');
  assert.ok(el, 'the key-on input must be rendered');
  return el as HTMLInputElement;
}

describe('CompareKeyProperty (#4989)', () => {
  it('does not commit per keystroke; commits once on Enter with the full value', () => {
    // A commit re-runs the whole comparison (both models re-fingerprinted),
    // so typing `Pset_Asset.AssetId` character by character (valid from
    // `Pset_Asset.A` on) must not fire `onKeyProperty` until the user is
    // actually done — one call, not ~8.
    const applied: (string | undefined)[] = [];
    const container = render(
      <CompareKeyProperty keyProperty={undefined} onKeyProperty={(v) => applied.push(v)} duplicateNote={null} />,
    );
    const el = input(container);
    const full = 'Pset_Asset.AssetId';
    for (let i = 1; i <= full.length; i++) {
      typeInto(el, full.slice(0, i));
      assert.equal(applied.length, 0, `no commit yet after "${full.slice(0, i)}"`);
    }
    press(el, 'Enter');
    assert.deepEqual(applied, [full]);
  });

  it('commits on blur too', () => {
    const applied: (string | undefined)[] = [];
    const container = render(
      <CompareKeyProperty keyProperty={undefined} onKeyProperty={(v) => applied.push(v)} duplicateNote={null} />,
    );
    const el = input(container);
    typeInto(el, 'Tag');
    assert.equal(applied.length, 0, 'no commit before blur');
    blur(el);
    assert.deepEqual(applied, ['Tag']);
  });

  it('clears any invalid note once the committed value is valid', () => {
    const container = render(
      <CompareKeyProperty keyProperty={undefined} onKeyProperty={() => {}} duplicateNote={null} />,
    );
    const el = input(container);
    typeInto(el, 'Tag');
    press(el, 'Enter');
    assert.equal(container.textContent?.includes('Not a valid key'), false);
  });

  it('shows an inline note for an invalid spec and never commits it, even on Enter', () => {
    const applied: (string | undefined)[] = [];
    const container = render(
      <CompareKeyProperty keyProperty={undefined} onKeyProperty={(v) => applied.push(v)} duplicateNote={null} />,
    );
    const el = input(container);
    typeInto(el, 'not a valid spec');
    assert.ok(container.textContent?.includes('Not a valid key'), 'the note is live, not deferred to commit');
    press(el, 'Enter');
    assert.deepEqual(applied, [], 'an invalid spec must never reach the store');
  });

  it('names the still-applied scheme in the invalid-spec note (GlobalId when none applied)', () => {
    const container = render(
      <CompareKeyProperty keyProperty={undefined} onKeyProperty={() => {}} duplicateNote={null} />,
    );
    typeInto(input(container), 'not valid');
    const text = container.textContent ?? '';
    assert.ok(text.includes('Still comparing on'), text);
    assert.ok(text.includes('GlobalId'), text);
  });

  it('names the last APPLIED scheme in the invalid-spec note, not GlobalId, once one is applied', () => {
    // The code deliberately leaves the last committed scheme in place while
    // the field holds an invalid edit — the message must say so honestly.
    const container = render(
      <CompareKeyProperty keyProperty="Pset_Asset.AssetId" onKeyProperty={() => {}} duplicateNote={null} />,
    );
    typeInto(input(container), 'not valid');
    const text = container.textContent ?? '';
    assert.ok(text.includes('Still comparing on'), text);
    assert.ok(text.includes('Pset_Asset.AssetId'), text);
    assert.equal(text.includes('Comparing on GlobalId until fixed'), false);
  });

  it('clearing the field back to empty commits undefined (GlobalId) immediately, no Enter needed', () => {
    const applied: (string | undefined)[] = [];
    const container = render(
      <CompareKeyProperty keyProperty="Tag" onKeyProperty={(v) => applied.push(v)} duplicateNote={null} />,
    );
    typeInto(input(container), '');
    assert.deepEqual(applied, [undefined]);
  });

  it('renders the duplicate-authored-key note when given one, alongside a valid applied value', () => {
    const container = render(
      <CompareKeyProperty
        keyProperty="Tag"
        onKeyProperty={() => {}}
        duplicateNote="2 authored values shared by several elements fell back to GlobalId: A, B"
      />,
    );
    assert.ok(container.textContent?.includes('fell back to GlobalId: A, B'));
  });

  it('hides the duplicate note while the field is showing an invalid-spec note instead', () => {
    const container = render(
      <CompareKeyProperty
        keyProperty="Tag"
        onKeyProperty={() => {}}
        duplicateNote="1 authored value shared by several elements fell back to GlobalId: A"
      />,
    );
    typeInto(input(container), 'not valid');
    assert.ok(container.textContent?.includes('Not a valid key'));
    assert.equal(container.textContent?.includes('fell back to GlobalId: A'), false);
  });
});
