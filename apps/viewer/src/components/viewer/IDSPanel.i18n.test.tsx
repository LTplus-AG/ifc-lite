/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { idsPanelEn } from '@/i18n/catalogues/ids-panel.en';
import { useViewerStore } from '@/store';
import type { IDSDocument, IDSValidationReport } from '@ifc-lite/ids';
import { IDSPanel } from './IDSPanel.js';

const initial = useViewerStore.getState();

const documentFixture: IDSDocument = {
  info: { title: 'Fixture IDS', version: '1.0', description: 'Fixture description' },
  specifications: [{
    id: 'spec-a',
    name: 'Wall requirements',
    ifcVersions: ['IFC4'],
    applicability: { facets: [] },
    requirements: [],
  }],
};

const reportFixture: IDSValidationReport = {
  document: documentFixture,
  modelInfo: { modelId: 'model-a', schemaVersion: 'IFC4', entityCount: 1234 },
  timestamp: new Date(0),
  summary: {
    totalSpecifications: 1,
    passedSpecifications: 0,
    failedSpecifications: 1,
    totalEntitiesChecked: 1234,
    totalEntitiesPassed: 0,
    totalEntitiesFailed: 1234,
    overallPassRate: 0,
  },
  specificationResults: [{
    specification: documentFixture.specifications[0],
    status: 'fail',
    applicableCount: 1234,
    passedCount: 0,
    failedCount: 1234,
    passRate: 0,
    entityResults: [],
  }],
};

function pseudoCatalogue(): Catalogue {
  return Object.fromEntries(Object.entries(idsPanelEn).map(([key, value]) => {
    if (typeof value === 'string') return [key, `⟦${key}⟧ ${value}`];
    return [key, Object.fromEntries(Object.entries(value).map(([category, form]) => [category, `⟦${key}:${category}⟧ ${form}`]))];
  }));
}

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({
    ...initial,
    idsDocument: null,
    idsValidationReport: null,
    idsAuditReport: null,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
  });
});

describe('IDSPanel localization (#4918)', () => {
  it('retranslates the mounted empty state from the active pseudo-locale', () => {
    registerLocale('en-x-ids-pseudo', pseudoCatalogue());
    const ui = render(<IDSPanel onClose={() => {}} />);
    assert.match(ui.textContent ?? '', /IDS Validation/);
    assert.match(ui.textContent ?? '', /No IDS Loaded/);

    act(() => setLocale('en-x-ids-pseudo'));
    const text = ui.textContent ?? '';
    assert.match(text, /⟦idsPanel\.title⟧/);
    assert.match(text, /⟦idsPanel\.noIdsLoaded⟧/);
    assert.match(text, /⟦idsPanel\.loadDescription⟧/);
    assert.match(text, /⟦idsPanel\.loadFile⟧/);
    assert.equal(ui.querySelector('[aria-label="Close"]'), null, 'the close accessible name also retranslates');
  });

  it('localizes complete result messages, controls, and active-locale numbers', () => {
    registerLocale('en-x-ids-results', pseudoCatalogue());
    useViewerStore.setState({
      idsDocument: documentFixture,
      idsValidationReport: reportFixture,
      idsAuditReport: null,
      idsError: null,
      idsLoading: false,
      idsProgress: null,
    });
    setLocale('en-x-ids-results');
    const ui = render(<IDSPanel />);
    const text = ui.textContent ?? '';
    assert.match(text, /⟦idsPanel\.specificationsPassed⟧/);
    assert.match(text, /⟦idsPanel\.checked⟧/);
    assert.match(text, /⟦idsPanel\.filter\.all⟧/);
    assert.match(text, /⟦idsPanel\.scope\.wholeIds⟧/);
    assert.match(text, /⟦idsPanel\.onSelect⟧/);
    assert.match(text, /⟦idsPanel\.focus\.highlight⟧/);

    const card = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Wall requirements'));
    assert.ok(card);
    click(card!);
    assert.match(ui.textContent ?? '', /⟦idsPanel\.noRequirements⟧/);
    assert.match(ui.textContent ?? '', /⟦idsPanel\.noEntities⟧/);

    registerLocale('ar-EG-u-nu-arab', {});
    act(() => setLocale('ar-EG-u-nu-arab'));
    assert.match(ui.textContent ?? '', new RegExp(new Intl.NumberFormat('ar-EG-u-nu-arab').format(1234)));
    assert.doesNotMatch(ui.textContent ?? '', /1234 Checked/);
  });
});
