/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hosting page-view script follows the analytics opt-out and waits for
 * the first-visit notice, like product analytics. Only the refusing cases are
 * rendered: an injected script would make happy-dom fetch it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render';
import * as hosting from './HostingAnalytics';
import * as consent from '@/lib/analytics-consent';
import { resetFeaturesForTest } from '@/lib/features';

type BeforeSendEvent = { type: 'pageview' | 'event'; url: string };
const added = hosting as typeof hosting & {
  hostingAnalyticsAllowed?: () => boolean;
  hostingAnalyticsBeforeSend?: (event: BeforeSendEvent) => BeforeSendEvent | null;
};
const consentAdded = consent as typeof consent & {
  markPrivacyNoticeShown?: () => void;
  resetPrivacyNoticeForTest?: () => void;
};

const scripts = () => document.querySelectorAll('script').length;

beforeEach(() => {
  localStorage.clear();
  consentAdded.resetPrivacyNoticeForTest?.();
  resetFeaturesForTest();
});
afterEach(() => {
  cleanup();
  consent.persistAnalyticsOptOut(false);
  localStorage.clear();
  consentAdded.resetPrivacyNoticeForTest?.();
  resetFeaturesForTest();
});

describe('hosting page-view analytics honour the opt-out', () => {
  it('is not injected for a visitor who opted out', () => {
    consentAdded.markPrivacyNoticeShown?.();
    consent.persistAnalyticsOptOut(true);
    const before = scripts();
    const host = render(<hosting.HostingAnalytics />);
    assert.equal(scripts(), before, 'no script element added');
    assert.equal(host.childElementCount, 0);
    assert.ok(added.hostingAnalyticsAllowed);
    assert.equal(added.hostingAnalyticsAllowed(), false);
  });

  it('is not injected before the first-visit notice, and is allowed once it was shown', () => {
    assert.ok(added.hostingAnalyticsAllowed, 'hostingAnalyticsAllowed is exported');
    assert.ok(consentAdded.markPrivacyNoticeShown, 'markPrivacyNoticeShown is exported');
    const before = scripts();
    render(<hosting.HostingAnalytics />);
    assert.equal(scripts(), before, 'no script before the notice');
    assert.equal(added.hostingAnalyticsAllowed(), false);
    // Unmounted first, so marking the notice cannot re-render it into a real
    // script injection outside the test's control; the decision is read directly.
    cleanup();
    consentAdded.markPrivacyNoticeShown();
    assert.equal(added.hostingAnalyticsAllowed(), true);
    consent.persistAnalyticsOptOut(true);
    assert.equal(added.hostingAnalyticsAllowed(), false, 'an opt-out in the same tab withdraws it');
  });

  it('a host without the notice does not wait for it', () => {
    assert.ok(added.hostingAnalyticsAllowed);
    resetFeaturesForTest({ default: 'all', disable: ['privacy.notice'] });
    assert.equal(added.hostingAnalyticsAllowed(), true);
  });

  it('drops page views after an opt-out and never sends a query string or hash', () => {
    assert.ok(added.hostingAnalyticsBeforeSend);
    const view = { type: 'pageview' as const, url: 'https://ifclite.com/?model=https%3A%2F%2Fexample.com%2Fclient-tower.ifc#sel=1' };
    assert.deepEqual(added.hostingAnalyticsBeforeSend(view), { type: 'pageview', url: 'https://ifclite.com/' });
    assert.equal(added.hostingAnalyticsBeforeSend({ type: 'pageview', url: 'not a url' }), null);
    consent.persistAnalyticsOptOut(true);
    assert.equal(added.hostingAnalyticsBeforeSend(view), null);
  });
});
