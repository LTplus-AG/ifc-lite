/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The catalogue and the gates agree, and the gates work.
 *
 * A catalogue entry is a promise to a host: "switch this off and your users
 * do not see it". The first test fails when an entry has no gate behind it,
 * so a feature cannot be listed before the code hides it. `GATED_SURFACES`
 * runs every surface that gates without a registry table; a gate table
 * (panels, commands, shortcuts) adds its ids to `GATE_TABLES`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render';
import { startAnalytics } from '@/lib/analytics';
import { usePrivacyDisclosure } from '@/hooks/usePrivacyDisclosure';
import { HostingAnalytics } from '@/components/HostingAnalytics';
import { AnalyticsConsentSection } from '@/components/viewer/settings/AnalyticsConsentSection';
import { FEATURE_CATALOGUE, type FeatureId } from './catalogue';
import { featuresAskedForTest, resetFeaturesForTest } from './index';

function PrivacyNoticeHost() {
  usePrivacyDisclosure();
  return null;
}

/** Ids named by a registry gate table; empty until a table exists. */
const GATE_TABLES: readonly FeatureId[] = [];

/** Surfaces with no registry: rendering or calling them asks about their feature. */
function runGatedSurfaces(): void {
  startAnalytics();
  render(<HostingAnalytics />);
  render(<PrivacyNoticeHost />);
  render(<AnalyticsConsentSection />);
}

afterEach(() => {
  cleanup();
  resetFeaturesForTest();
});

describe('every catalogue feature has a gate behind it', () => {
  it('is named by a gate table or asked about by a surface that renders', () => {
    // Switched off, so asking is all the surfaces do (no analytics start, no script tag).
    resetFeaturesForTest({ default: 'none' });
    runGatedSurfaces();
    const gated = new Set<FeatureId>([...GATE_TABLES, ...featuresAskedForTest()]);
    const ungated = FEATURE_CATALOGUE.map((feature) => feature.id).filter((id) => !gated.has(id));
    assert.deepEqual(ungated, [], 'listed in the catalogue, but nothing hides it');
  });
});

describe('privacy features switched off', () => {
  it('the hosting analytics script is not injected', () => {
    resetFeaturesForTest({ default: 'all', disable: ['privacy.vercel-analytics'] });
    const before = document.querySelectorAll('script').length;
    const host = render(<HostingAnalytics />);
    assert.equal(document.querySelectorAll('script').length, before, 'no script element added');
    assert.equal(host.childElementCount, 0);
  });

  it('the analytics opt-out setting is not offered, since nothing is sent', () => {
    const shown = render(<AnalyticsConsentSection />);
    assert.notEqual(shown.textContent, '', 'offered by default');
    cleanup();
    resetFeaturesForTest({ default: 'all', disable: ['privacy.analytics'] });
    assert.equal(render(<AnalyticsConsentSection />).textContent, '');
  });
});
