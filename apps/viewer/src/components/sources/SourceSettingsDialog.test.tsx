/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PluginPreferenceType` declares four kinds — `textfield`, `password`,
 * `checkbox`, `dropdown` — and the host renders the settings form from the
 * manifest, so a provider has no other way to get a control on screen.
 * `PreferenceField` used to render `<Input type={password ? 'password' :
 * 'text'}>` for all four, which means a declared `dropdown` came out as a
 * free-text box: no option list shown, and any string at all typeable into a
 * field whose whole point is that only the declared values are legal. A
 * `checkbox` came out the same way, with the user expected to type the word
 * "true".
 *
 * These tests pin the rendered control per declared type, in both directions
 * where the type is a binary (a checkbox reads AND writes `"true"`/`"false"`;
 * a dropdown offers exactly the declared options and reports the option's
 * VALUE, not its label).
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PluginManifest, PluginPreference } from '@ifc-lite/plugin-api';
import { SourceSettingsDialog } from './SourceSettingsDialog.js';

function makeManifest(preferences: readonly PluginPreference[]): PluginManifest {
  return {
    name: 'test-provider',
    title: 'Test Provider',
    api: '^2.0.0',
    permissions: { network: [] },
    auth: 'preferences',
    preferences,
    capabilities: {
      containerListing: 'direct-children',
      listFilesIsRecursive: false,
      revisionHistory: false,
      downloadHistoricalRevisions: false,
      changeDetection: false,
      search: false,
    },
    contributes: { fileSources: [] },
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderDialog(
  preferences: readonly PluginPreference[],
  initialValues: Record<string, string> = {},
): { saved: Array<Record<string, string>> } {
  const saved: Array<Record<string, string>> = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SourceSettingsDialog
        manifest={makeManifest(preferences)}
        open
        onOpenChange={() => {}}
        onSave={(values) => saved.push(values)}
        initialValues={initialValues}
      />,
    );
  });
  mounted.push({ root, container });
  return { saved };
}

/** The dialog content is portaled, so everything is looked up from `body`. */
function field(name: string): HTMLElement {
  const el = document.body.querySelector(`#pref-${name}`);
  assert.ok(el, `a control for preference "${name}" must render`);
  return el as HTMLElement;
}

function clickSave(): void {
  const save = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Save',
  );
  assert.ok(save, 'the Save button must render');
  act(() => {
    save.click();
  });
}

beforeEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  document.body.innerHTML = '';
});

describe('SourceSettingsDialog — text and password preferences keep their control', () => {
  it('renders a text input for textfield', () => {
    renderDialog([
      { name: 'region', title: 'Region', type: 'textfield', required: false },
    ]);
    const el = field('region');
    assert.equal(el.tagName, 'INPUT');
    assert.equal(el.getAttribute('type'), 'text');
  });

  it('renders a masked input for password', () => {
    renderDialog([
      { name: 'apiKey', title: 'API key', type: 'password', required: false },
    ]);
    const el = field('apiKey');
    assert.equal(el.tagName, 'INPUT');
    assert.equal(el.getAttribute('type'), 'password');
  });
});

describe('SourceSettingsDialog — checkbox preferences', () => {
  const pref: PluginPreference = {
    name: 'useProxy',
    title: 'Route through the proxy',
    type: 'checkbox',
    required: false,
    default: 'false',
  };

  it('does NOT render a free-text box for a checkbox', () => {
    renderDialog([pref]);
    const el = field('useProxy');
    assert.notEqual(
      el.tagName,
      'INPUT',
      'a checkbox preference must not be a typed-in text field',
    );
  });

  it('renders unchecked for the stored value "false"', () => {
    renderDialog([pref], { useProxy: 'false' });
    assert.equal(field('useProxy').getAttribute('aria-checked'), 'false');
  });

  it('renders checked for the stored value "true"', () => {
    renderDialog([pref], { useProxy: 'true' });
    assert.equal(field('useProxy').getAttribute('aria-checked'), 'true');
  });

  it('saves "true" after the user turns it on', () => {
    const { saved } = renderDialog([pref], { useProxy: 'false' });
    act(() => {
      field('useProxy').click();
    });
    clickSave();
    assert.deepEqual(saved, [{ useProxy: 'true' }]);
  });

  it('saves "false" after the user turns it off', () => {
    const { saved } = renderDialog([pref], { useProxy: 'true' });
    act(() => {
      field('useProxy').click();
    });
    clickSave();
    assert.deepEqual(saved, [{ useProxy: 'false' }]);
  });
});

describe('SourceSettingsDialog — dropdown preferences', () => {
  const pref: PluginPreference = {
    name: 'environment',
    title: 'Environment',
    type: 'dropdown',
    required: false,
    default: 'prod',
    options: [
      { label: 'Production', value: 'prod' },
      { label: 'Staging', value: 'stage' },
    ],
  };

  /** Radix's Select opens on ArrowDown; the listbox is portaled to `body`. */
  function openDropdown(): HTMLElement[] {
    act(() => {
      field('environment').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    });
    return [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[];
  }

  it('does NOT render a free-text box for a dropdown', () => {
    renderDialog([pref]);
    const el = field('environment');
    assert.notEqual(
      el.tagName,
      'INPUT',
      'a dropdown preference must not accept arbitrary typed values',
    );
  });

  it('shows the label of the currently stored value', () => {
    renderDialog([pref], { environment: 'stage' });
    assert.match(field('environment').textContent ?? '', /Staging/);
  });

  it('offers exactly the declared options, by label', () => {
    renderDialog([pref]);
    assert.deepEqual(
      openDropdown().map((o) => o.textContent),
      ['Production', 'Staging'],
    );
  });

  it('saves the option VALUE, not its label, when one is chosen', () => {
    const { saved } = renderDialog([pref], { environment: 'prod' });
    const staging = openDropdown().find((o) => o.textContent === 'Staging');
    assert.ok(staging, 'the Staging option must be offered');
    act(() => {
      staging.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    clickSave();
    assert.deepEqual(saved, [{ environment: 'stage' }]);
  });

  it('renders no options for a dropdown that declares none, rather than crashing', () => {
    renderDialog([{ ...pref, options: undefined, default: undefined }], {});
    assert.deepEqual(openDropdown(), []);
  });
});
