/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loader's LandXML failure handler publishes at most the prompt whose
 * choice can fix the failure: a units prompt for LXML009 (#5175), a
 * georeferencing-assumption prompt for a refused federation with a non-empty
 * offer. The assumption settings are a workspace preference that outlives a
 * session reset; the prompt dies with the load it belongs to.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { useViewerStore } from '../../store/index.js';
import { parseLandXmlGeorefAssumptionSettings } from '../../store/slices/landXmlGeorefAssumptionSettings.js';
import { LandXmlFederationRefusedError, NO_LANDXML_GEOREF_ASSUMPTIONS } from './landXmlGeorefAssumptions.js';
import { clearLandXmlRefusalPrompts, publishLandXmlRefusalPrompts, type LandXmlRefusalRetryOptions } from './landXmlRefusalPrompts.js';

const LXML009_MESSAGE = 'LXML009: a numeric, renderable TIN surface requires a LandXML/Units element with a linearUnit attribute';
const REFUSAL = 'LandXML federation preflight rejected every render component: its surfaces lie up to 5,516 km from the shared render origin.';

afterEach(() => clearLandXmlRefusalPrompts());

describe('LandXML refusal prompts', () => {
  it('offers the assumption prompt for a refused federation, and its retry carries the user\'s choice', () => {
    const retries: LandXmlRefusalRetryOptions[] = [];
    const error = new LandXmlFederationRefusedError(REFUSAL, ['epsgFromName', 'sharedVerticalDatum']);
    publishLandXmlRefusalPrompts(error.message, error, 'terrain.xml', (retry) => retries.push(retry));
    const state = useViewerStore.getState();
    assert.equal(state.landXmlUnitsRefusal, null);
    const prompt = state.landXmlAssumptionRefusal;
    assert.ok(prompt);
    assert.equal(prompt.fileName, 'terrain.xml');
    assert.equal(prompt.message, REFUSAL);
    assert.deepEqual(prompt.offer, ['epsgFromName', 'sharedVerticalDatum']);
    prompt.retry({ sharedVerticalDatum: true, epsgFromName: true });
    assert.deepEqual(retries, [{ landXmlAssumptions: { sharedVerticalDatum: true, epsgFromName: true } }]);
  });

  it('offers nothing when no assumption would align it, and drops a stale prompt', () => {
    const offered = new LandXmlFederationRefusedError(REFUSAL, ['sharedVerticalDatum']);
    publishLandXmlRefusalPrompts(offered.message, offered, 'a.xml', () => {});
    const nothing = new LandXmlFederationRefusedError(REFUSAL, []);
    publishLandXmlRefusalPrompts(nothing.message, nothing, 'b.xml', () => {});
    assert.equal(useViewerStore.getState().landXmlAssumptionRefusal, null);
    // A plain Error with the same text is not a structured refusal either.
    publishLandXmlRefusalPrompts(REFUSAL, new Error(REFUSAL), 'c.xml', () => {});
    assert.equal(useViewerStore.getState().landXmlAssumptionRefusal, null);
  });

  it('keeps the units prompt for LXML009, which no georeferencing assumption fixes (#5175)', () => {
    const retries: LandXmlRefusalRetryOptions[] = [];
    publishLandXmlRefusalPrompts(LXML009_MESSAGE, new Error(LXML009_MESSAGE), 'units.xml', (retry) => retries.push(retry));
    const state = useViewerStore.getState();
    assert.equal(state.landXmlAssumptionRefusal, null);
    state.landXmlUnitsRefusal?.retry('foot');
    assert.deepEqual(retries, [{ assumedLinearUnit: 'foot' }]);
  });

  it('a session reset ends the prompt but keeps the user\'s standing settings', () => {
    const error = new LandXmlFederationRefusedError(REFUSAL, ['sharedVerticalDatum']);
    publishLandXmlRefusalPrompts(error.message, error, 'terrain.xml', () => {});
    useViewerStore.getState().setLandXmlGeorefAssumptionSettings({ sharedVerticalDatum: true });
    try {
      useViewerStore.getState().resetViewerState();
      const state = useViewerStore.getState();
      assert.equal(state.landXmlAssumptionRefusal, null);
      assert.deepEqual(state.landXmlGeorefAssumptionSettings, { sharedVerticalDatum: true, epsgFromName: false });
    } finally {
      useViewerStore.getState().setLandXmlGeorefAssumptionSettings(NO_LANDXML_GEOREF_ASSUMPTIONS);
    }
  });
});

describe('stored LandXML georeferencing assumption settings', () => {
  it('turn an assumption on only for an explicit true, so a malformed entry never enables one', () => {
    assert.deepEqual(parseLandXmlGeorefAssumptionSettings({ sharedVerticalDatum: true, epsgFromName: false }), { sharedVerticalDatum: true, epsgFromName: false });
    for (const raw of [null, 'true', [true], { sharedVerticalDatum: 'true', epsgFromName: 1 }, {}]) {
      assert.deepEqual(parseLandXmlGeorefAssumptionSettings(raw), NO_LANDXML_GEOREF_ASSUMPTIONS, JSON.stringify(raw));
    }
  });
});
