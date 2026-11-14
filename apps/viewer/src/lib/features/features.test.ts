/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_CATALOGUE, FEATURE_GROUPS, featureCatalogueDocument } from './catalogue';
import { applyFeatureSelection, disabledFeatures, isFeatureEnabled, resetFeaturesForTest } from './index';
import { ViewerConfigError } from './runtime-config';
import { applyRuntimeConfig } from './runtime-start';

afterEach(() => resetFeaturesForTest());

describe('which features a selection switches off', () => {
  it('is nothing when the host sent no selection', () => {
    assert.equal(disabledFeatures(undefined).size, 0);
  });

  it("is the disable list under default 'all'", () => {
    const off = disabledFeatures({ default: 'all', disable: ['privacy.analytics', 'privacy.notice'] });
    assert.deepEqual([...off].sort(), ['privacy.analytics', 'privacy.notice']);
  });

  it("is everything but the enable list under default 'none'", () => {
    const off = disabledFeatures({ default: 'none', enable: ['privacy.analytics', 'privacy.notice'] });
    assert.equal(off.size, FEATURE_CATALOGUE.length - 2);
    assert.equal(off.has('privacy.analytics'), false);
    assert.equal(off.has('privacy.notice'), false);
    assert.equal(off.has('privacy.vercel-analytics'), true);
  });

  it('reads only the list its default calls for', () => {
    assert.equal(disabledFeatures({ default: 'all', enable: ['privacy.notice'] }).size, 0);
    assert.equal(
      disabledFeatures({ default: 'none', disable: ['privacy.notice'] }).size,
      FEATURE_CATALOGUE.length,
      "a disable list cannot switch anything on under 'none'",
    );
  });

  it('ignores ids this viewer does not know, so a newer config does not break it', () => {
    const off = disabledFeatures({ default: 'all', disable: ['future.feature', 'privacy.notice', ''] });
    assert.deepEqual([...off], ['privacy.notice']);
    const none = disabledFeatures({ default: 'none', enable: ['future.feature', 'privacy.analytics'] });
    assert.equal(none.size, FEATURE_CATALOGUE.length - 1);
  });
});

describe('the page feature set', () => {
  it('has every feature on until a host configures it', () => {
    for (const { id } of FEATURE_CATALOGUE) assert.equal(isFeatureEnabled(id), true, id);
  });

  it('answers from the applied selection', () => {
    applyFeatureSelection({ default: 'none', enable: ['privacy.notice'] });
    assert.equal(isFeatureEnabled('privacy.notice'), true);
    assert.equal(isFeatureEnabled('privacy.analytics'), false);
  });

  it('is fixed once: a second configuration is refused', () => {
    applyFeatureSelection(undefined);
    assert.throws(() => applyFeatureSelection({ default: 'none' }), /already fixed/);
  });

  it('refuses to be configured after a gate already answered', () => {
    // A gate that ran early answered "on" for something the host may switch
    // off; the mount must fail loudly instead of leaking that surface.
    isFeatureEnabled('privacy.analytics');
    assert.throws(() => applyFeatureSelection({ default: 'none' }), /before the viewer configuration was applied: privacy\.analytics/);
  });
});

describe('the catalogue a build publishes', () => {
  it('uses stable dotted lower-case ids, unique, each in a declared group', () => {
    const groups = new Set<string>(FEATURE_GROUPS.map((group) => group.id));
    const seen = new Set<string>();
    for (const feature of FEATURE_CATALOGUE) {
      assert.match(feature.id, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, feature.id);
      assert.equal(feature.id.split('.')[0], feature.group, `${feature.id} is named for its group`);
      assert.ok(groups.has(feature.group), `${feature.id}: unknown group ${feature.group}`);
      assert.equal(seen.has(feature.id), false, `duplicate id ${feature.id}`);
      seen.add(feature.id);
      assert.ok(feature.label.trim() && feature.description.trim(), `${feature.id} needs a label and a description`);
    }
    assert.equal(new Set(FEATURE_GROUPS.map((group) => group.id)).size, FEATURE_GROUPS.length);
  });

  it('is the features.json document a host reads: version, groups and four keys per feature', () => {
    const document = featureCatalogueDocument();
    assert.equal(document.version, 1);
    assert.deepEqual(Object.keys(document.features[0]).sort(), ['description', 'group', 'id', 'label']);
    assert.deepEqual(document.groups.map((group) => group.id), FEATURE_GROUPS.map((group) => group.id));
  });
});

describe('a configuration handed over directly', () => {
  it('is checked like a fetched one, so a malformed one fails closed instead of enabling everything', () => {
    for (const config of [
      { version: 1, features: { default: 'None', enable: ['privacy.notice'] } },
      { version: 1, features: { default: 'all', disable: 'privacy.analytics' } },
    ]) {
      resetFeaturesForTest();
      assert.throws(() => applyRuntimeConfig(config), (error) => error instanceof ViewerConfigError && error.code === 'invalid', JSON.stringify(config));
      // Nothing was applied: the page is not running with everything on by mistake, it did not start.
      assert.doesNotThrow(() => applyFeatureSelection({ default: 'none' }));
    }
  });
});
