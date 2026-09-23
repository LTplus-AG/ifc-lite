/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5175 review: the prompt stays mounted when `landXmlUnitsRefusal` clears, so
 * a unit chosen for one file must not still be selected when the NEXT file
 * refuses. Leaving it selected would arm the retry before the user has chosen
 * anything for that file — the viewer assuming a unit on the operator's
 * behalf, which is the failure this whole feature exists to prevent.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, cleanup, click } from '@/test/render';
import { LandXmlUnitsRefusalPrompt } from './LandXmlUnitsRefusalPrompt.js';

const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

function retryButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')]
    .find((b) => /retry|reload|load/i.test(b.textContent ?? '') && !/dismiss|close/i.test(b.textContent ?? ''));
}

describe('LandXmlUnitsRefusalPrompt (#5175)', () => {
  it('renders nothing until a units refusal is published', () => {
    render(<LandXmlUnitsRefusalPrompt />);
    assert.equal(document.body.textContent?.trim(), '', 'no refusal means no prompt');
  });

  it('starts with no unit chosen, so retry is unavailable', () => {
    useViewerStore.setState({ landXmlUnitsRefusal: { fileName: 'a.xml', retry: () => {} } });
    render(<LandXmlUnitsRefusalPrompt />);
    const retry = retryButton();
    assert.ok(retry, 'the prompt offers a retry control');
    assert.equal(retry.disabled, true, 'retry stays disabled until the user picks a unit');
  });

  it('does not carry a unit chosen for one file into the next refusal', () => {
    const first = { fileName: 'a.xml', retry: () => {} };
    useViewerStore.setState({ landXmlUnitsRefusal: first });
    render(<LandXmlUnitsRefusalPrompt />);

    // Choose a unit for the first file through the real picker.
    const trigger = document.querySelector('[role="combobox"]');
    assert.ok(trigger, 'the prompt renders a unit selector');
    click(trigger);
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((o) => /foot/i.test(o.textContent ?? ''));
    assert.ok(option, 'the picker offers the parser-accepted units');
    click(option);
    assert.equal(retryButton()?.disabled, false, 'choosing a unit enables retry');

    // A different file refuses next. Wrapped in `act` so React flushes the
    // re-render and its effects before the assertion reads the DOM.
    act(() => {
      useViewerStore.setState({ landXmlUnitsRefusal: null });
      useViewerStore.setState({ landXmlUnitsRefusal: { fileName: 'b.xml', retry: () => {} } });
    });

    assert.equal(
      retryButton()?.disabled,
      true,
      'the new file starts with nothing chosen — the previous selection must not arm its retry',
    );
  });
});
