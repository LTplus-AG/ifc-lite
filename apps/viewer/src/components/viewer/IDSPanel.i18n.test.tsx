/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import { useViewerStore } from '@/store';
import type { IDSDocument, IDSRequirement, IDSRequirementResult, IDSValidationReport } from '@ifc-lite/ids';
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
    applicableCount: 2,
    passedCount: 1,
    failedCount: 1,
    passRate: 50,
    entityResults: [{
      expressId: 1,
      modelId: 'model-a',
      entityType: 'IfcWall',
      entityName: 'Wall A',
      passed: true,
      requirementResults: [],
    }, {
      expressId: 2,
      modelId: 'model-a',
      entityType: 'IfcDoor',
      entityName: 'Door B',
      passed: false,
      requirementResults: [],
    }],
  }],
};

function pseudoCatalogue(): Catalogue {
  return Object.fromEntries(Object.entries(en).map(([key, value]) => {
    if (typeof value === 'string') return [key, `⟦${key}⟧ ${value}`];
    return [key, Object.fromEntries(Object.entries(value).map(([category, form]) => [category, `⟦${key}:${category}⟧ ${form}`]))];
  }));
}

function requirementResult(id: string): IDSRequirementResult {
  const requirement: IDSRequirement = {
    id,
    facet: {
      type: 'attribute',
      name: { type: 'simpleValue', value: 'Name' },
    },
    optionality: 'required',
  };
  return {
    requirement,
    status: 'pass',
    facetType: 'attribute',
    checkedDescription: `Checks ${id}`,
  };
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
  it('keeps entity selection and detail disclosure as separate keyboard-focusable controls', () => {
    useViewerStore.setState({
      idsDocument: documentFixture,
      idsValidationReport: reportFixture,
      idsAuditReport: null,
      idsError: null,
      idsLoading: false,
      idsProgress: null,
    });
    const ui = render(<IDSPanel />);
    const card = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Wall requirements'));
    assert.ok(card);
    click(card!);
    const selection = ui.querySelector<HTMLButtonElement>('[aria-label="Wall A - IfcWall - Passed"]');
    const disclosure = ui.querySelector<HTMLButtonElement>('[aria-label="Show details"]');

    assert.ok(selection);
    assert.ok(disclosure);
    assert.equal(selection!.tagName, 'BUTTON');
    assert.equal(disclosure!.tagName, 'BUTTON');
    assert.equal(selection!.contains(disclosure), false, 'interactive controls must not be nested');
    assert.equal(selection!.parentElement, disclosure!.parentElement, 'controls are sibling actions');
    assert.equal(disclosure!.tabIndex, 0, 'detail disclosure participates in keyboard navigation');

    click(disclosure!);
    assert.equal(disclosure!.getAttribute('aria-expanded'), 'true');
    assert.equal(disclosure!.getAttribute('aria-label'), 'Hide details');
  });

  it('passes the raw requirement count to locale plural selection', () => {
    registerLocale('ru-RU', {
      'idsPanel.checksPassedAcross': {
        one: 'ONE {requirements}',
        few: 'FEW {requirements}',
        many: 'MANY {requirements}',
        other: 'OTHER {requirements}',
      },
    });
    setLocale('ru-RU');
    const result = {
      ...reportFixture.specificationResults[0],
      entityResults: [{
        ...reportFixture.specificationResults[0].entityResults[0],
        requirementResults: [requirementResult('req-0'), requirementResult('req-1')],
      }],
    };
    useViewerStore.setState({
      idsDocument: documentFixture,
      idsValidationReport: { ...reportFixture, specificationResults: [result] },
      idsAuditReport: null,
      idsError: null,
      idsLoading: false,
      idsProgress: null,
    });

    const ui = render(<IDSPanel />);
    assert.match(ui.textContent ?? '', /FEW 2/, 'Russian count 2 selects the few form');
  });

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
    assert.match(text, /⟦idsPanel\.failedCount:one⟧/, 'plural selection receives the raw numeric count');

    const card = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Wall requirements'));
    assert.ok(card);
    click(card!);
    assert.match(ui.textContent ?? '', /⟦idsPanel\.noRequirements⟧/);
    assert.match(ui.textContent ?? '', /⟦idsPanel\.byEntity⟧/);

    registerLocale('ar-EG-u-nu-arab', {});
    act(() => setLocale('ar-EG-u-nu-arab'));
    assert.match(ui.textContent ?? '', new RegExp(new Intl.NumberFormat('ar-EG-u-nu-arab').format(1234)));
    assert.match(
      ui.textContent ?? '',
      new RegExp(new Intl.NumberFormat('ar-EG-u-nu-arab', {
        style: 'percent', maximumFractionDigits: 2,
      }).format(0)),
    );
    assert.match(
      ui.textContent ?? '',
      new RegExp(new Intl.NumberFormat('ar-EG-u-nu-arab', {
        style: 'percent', maximumFractionDigits: 2,
      }).format(0.5)),
    );
    assert.doesNotMatch(ui.textContent ?? '', /1234 Checked/);
  });

  it('falls back as one complete accessible entity label in a partial locale', () => {
    registerLocale('en-x-ids-partial', {
      'idsPanel.entityAriaLabelPassed': 'LOCAL {name} / {type} / passed',
      'idsPanel.status.failed': 'LOCAL failed status',
    });
    setLocale('en-x-ids-partial');
    useViewerStore.setState({
      idsDocument: documentFixture,
      idsValidationReport: reportFixture,
      idsAuditReport: null,
      idsError: null,
      idsLoading: false,
      idsProgress: null,
    });
    const ui = render(<IDSPanel />);
    const card = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Wall requirements'));
    assert.ok(card);
    click(card!);
    const labels = [...ui.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label'));
    assert.ok(labels.includes('LOCAL Wall A / IfcWall / passed'));
    assert.equal(
      labels.includes('Door B - IfcDoor - Failed'),
      true,
      'the missing compound key falls back wholly to English, despite a translated status key',
    );
  });
});
