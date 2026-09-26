/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkPropertyEditor, parseBulkSetPropertyValue } from './BulkPropertyEditor.js';
import { appliedResultKey } from './bulk-property-editor-options.js';
import { BulkExecutionResult } from './BulkExecutionResult.js';
import { BulkExecutionProgress } from './BulkExecutionProgress.js';

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('BulkPropertyEditor localization (#4918)', () => {
  it('#5892 uses the shared operator label after a live locale change', async () => {
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    click(container.querySelector('button')!);
    await advance(0);
    const addFilter = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Add Filter'));
    assert.ok(addFilter);
    click(addFilter);
    const operator = [...document.body.querySelectorAll('[role="combobox"]')]
      .find((element) => element.textContent?.trim() === '=');
    assert.ok(operator, 'new property filter shows the equality operator');

    registerLocale('bulk-shared-operator-witness', { 'filterOperators.eq': '[equal]' });
    act(() => setLocale('bulk-shared-operator-witness'));
    assert.equal(operator.textContent?.trim(), '[equal]');
  });

  it('names the property-filter remove action after adding a filter (#5811)', async () => {
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    click(container.querySelector('button')!);
    await advance(0);
    const addFilter = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('Add Filter'));
    assert.ok(addFilter);
    click(addFilter);
    const removeFilter = document.body.querySelector<HTMLButtonElement>('button[aria-label="Remove property filter"]');
    assert.ok(removeFilter);
    await act(async () => removeFilter.focus());
    assert.equal(document.body.querySelector('[role="tooltip"]')?.textContent, 'Remove property filter');
  });

  it('pluralizes the progress entity label from the total', () => {
    const singular = render(<BulkExecutionProgress done={0} total={1} />);
    assert.match(singular.textContent ?? '', /0 \/ 1 entity/);
    cleanup();
    const plural = render(<BulkExecutionProgress done={1} total={2} />);
    assert.match(plural.textContent ?? '', /1 \/ 2 entities/);
    cleanup();
    const malformed = render(<BulkExecutionProgress done={Number.NaN} total={1} />);
    assert.doesNotMatch(malformed.innerHTML, /NaN/, 'malformed progress must resolve to a finite width');
  });

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
    registerLocale('en-x-bulk-validation', {
      'bulkPropertyEditor.real': '[decimal]',
      'bulkPropertyEditor.invalidValue': '[{value} is no {type}]',
    });
    act(() => setLocale('en-x-bulk-validation'));
    const result = parseBulkSetPropertyValue('abc', PropertyValueType.Real);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.message, '[abc is no [decimal]]');
  });

  it('recomputes cached type labels when the mounted locale changes', async () => {
    useViewerStore.setState(fixtureModels(fixtureModel('model-a', {
      entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall A' }],
    })));
    registerLocale('en-x-bulk-live-label', { 'bulkPropertyEditor.type.wall': '[Mauer]' });

    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    click(container.querySelector('button')!);
    await advance(0);
    assert.match(document.body.textContent ?? '', /Wall/);

    act(() => setLocale('en-x-bulk-live-label'));
    await advance(0);
    assert.match(document.body.textContent ?? '', /\[Mauer\]/);
  });

  it('selects complete result messages with both active-locale plural categories', () => {
    assert.equal(appliedResultKey('ar', 2, 2), 'bulkPropertyEditor.appliedTwoTwo');
    assert.equal(appliedResultKey('ar', 5, 5), 'bulkPropertyEditor.appliedFewFew');
    assert.equal(appliedResultKey('pl', 5, 1), 'bulkPropertyEditor.appliedManyOne');
  });

  it('uses English plural rules when a partial locale falls back to English', () => {
    registerLocale('fr', { 'bulkPropertyEditor.success': '[Succès]' });
    setLocale('fr');
    const ui = render(<BulkExecutionResult
      result={{ success: true, mutations: [], affectedEntityCount: 0 }}
      validationFailure={null}
      runtimeFailures={[]}
    />);
    assert.match(ui.textContent ?? '', /Applied 0 mutations to 0 entities/);
    assert.doesNotMatch(ui.textContent ?? '', /Applied 0 mutation to 0 entity/);
  });

  it('recomputes the legacy current-model label on a live locale switch', async () => {
    const legacy = fixtureModel('legacy-model', {
      entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall A' }],
    });
    useViewerStore.setState({
      models: new Map(),
      ifcDataStore: legacy.ifcDataStore,
      geometryResult: legacy.geometryResult,
    });
    registerLocale('en-x-bulk-legacy-live', { 'bulkPropertyEditor.currentModel': '[Aktuelles Modell]' });
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    click(container.querySelector('button')!);
    await advance(0);
    assert.match(document.body.textContent ?? '', /Current Model/);
    act(() => setLocale('en-x-bulk-legacy-live'));
    await advance(0);
    assert.match(document.body.textContent ?? '', /\[Aktuelles Modell\]/);
  });

  it('invalidates cached labels when the active catalogue is replaced', async () => {
    const legacy = fixtureModel('legacy-replacement', {
      entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall A' }],
    });
    useViewerStore.setState({
      models: new Map(),
      ifcDataStore: legacy.ifcDataStore,
      geometryResult: legacy.geometryResult,
    });
    registerLocale('en-x-bulk-replacement', {
      'bulkPropertyEditor.currentModel': '[first model]',
    });
    setLocale('en-x-bulk-replacement');
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    click(container.querySelector('button')!);
    await advance(0);
    assert.match(document.body.textContent ?? '', /\[first model\]/);
    act(() => registerLocale('en-x-bulk-replacement', {
      'bulkPropertyEditor.currentModel': '[second model]',
    }));
    await advance(0);
    assert.match(document.body.textContent ?? '', /\[second model\]/);
  });

  it('invalidates cached type labels when the active catalogue is replaced', async () => {
    useViewerStore.setState(fixtureModels(fixtureModel('replacement-model', {
      entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall A' }],
    })));
    registerLocale('en-x-bulk-type-replacement', { 'bulkPropertyEditor.type.wall': '[first wall]' });
    setLocale('en-x-bulk-type-replacement');
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    click(container.querySelector('button')!);
    await advance(0);
    assert.match(document.body.textContent ?? '', /\[first wall\]/);
    act(() => registerLocale('en-x-bulk-type-replacement', { 'bulkPropertyEditor.type.wall': '[second wall]' }));
    await advance(0);
    assert.match(document.body.textContent ?? '', /\[second wall\]/);
  });

  it('retranslates unknown runtime failures after a locale switch', () => {
    const ui = render(<BulkExecutionResult
      result={{ success: false, mutations: [], affectedEntityCount: 0, errors: [] }}
      validationFailure={null}
      runtimeFailures={[{ kind: 'execute' }]}
    />);
    assert.match(ui.textContent ?? '', /Unknown error/);
    registerLocale('en-x-bulk-runtime', {
      'bulkPropertyEditor.unknownError': '[unbekannter Fehler]',
      'bulkPropertyEditor.executionFailed': '[Ausführung: {detail}]',
    });
    act(() => setLocale('en-x-bulk-runtime'));
    assert.match(ui.textContent ?? '', /\[Ausführung: \[unbekannter Fehler\]\]/);
  });
});
