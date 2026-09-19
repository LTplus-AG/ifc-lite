/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkPropertyEditor, parseBulkSetPropertyValue } from './BulkPropertyEditor.js';

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('BulkPropertyEditor localization (#4918)', () => {
  it('updates the mounted dialog and complete plural message when the locale changes', () => {
    registerLocale('de', {
      'bulkPropertyEditor.trigger': '[Massenänderung]',
      'bulkPropertyEditor.title': '[Masseneigenschaften]',
      'bulkPropertyEditor.description': '[Elemente wählen und gemeinsam ändern]',
      'bulkPropertyEditor.selectionCriteria': '[Auswahlkriterien]',
      'bulkPropertyEditor.matched': { one: '[{countDisplay} Treffer]', other: '[{countDisplay} Treffer]' },
      'bulkPropertyEditor.noTypes': '[Modell laden]',
      'bulkPropertyEditor.action': '[Aktion]',
      'bulkPropertyEditor.apply': { one: '[Auf {countDisplay} Element anwenden]', other: '[Auf {countDisplay} Elemente anwenden]' },
    });

    const container = render(<BulkPropertyEditor />);
    assert.match(container.textContent ?? '', /Bulk Edit/);
    click(container.querySelector('button')!);
    assert.match(document.body.textContent ?? '', /Bulk Property Editor/);
    assert.match(document.body.textContent ?? '', /0 entities matched/);

    act(() => setLocale('de'));
    const text = document.body.textContent ?? '';
    assert.match(text, /\[Masseneigenschaften\]/);
    assert.match(text, /\[Elemente wählen und gemeinsam ändern\]/);
    assert.match(text, /\[Auswahlkriterien\]/);
    assert.match(text, /\[0 Treffer\]/);
    assert.match(text, /\[Modell laden\]/);
    assert.match(text, /\[Aktion\]/);
    assert.match(text, /\[Auf 0 Elemente anwenden\]/);
    assert.doesNotMatch(text, /Bulk Property Editor|Selection Criteria|entities matched/);
  });

  it('resolves validation messages from the active catalogue at action time', () => {
    registerLocale('bulk-validation', {
      'bulkPropertyEditor.real': '[decimal]',
      'bulkPropertyEditor.invalidValue': '[{value} is no {type}]',
    });
    act(() => setLocale('bulk-validation'));
    const result = parseBulkSetPropertyValue('abc', PropertyValueType.Real);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.message, '[abc is no [decimal]]');
  });
});
