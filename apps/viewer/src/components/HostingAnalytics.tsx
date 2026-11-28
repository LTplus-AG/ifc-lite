/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react';
import { Analytics, type BeforeSendEvent } from '@vercel/analytics/react';
import { isFeatureEnabled } from '@/lib/features';
import { isAnalyticsOptedOut, isPrivacyNoticeShown, subscribeAnalyticsConsent } from '@/lib/analytics-consent';

/**
 * The same rules as product analytics: nothing before the first-visit notice
 * has been shown (unless the host switched that notice off), and nothing once
 * the visitor has opted out.
 */
export function hostingAnalyticsAllowed(): boolean {
  if (isAnalyticsOptedOut()) return false;
  return !isFeatureEnabled('privacy.notice') || isPrivacyNoticeShown();
}

/**
 * Applied to every page view the script would send. The script stays on the
 * page after an opt-out in the same tab, so this drops its later page views;
 * and it sends only the route, never a query string or hash (`?model=` can
 * name a model file).
 */
export function hostingAnalyticsBeforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  if (isAnalyticsOptedOut()) return null;
  try {
    const url = new URL(event.url);
    url.search = '';
    url.hash = '';
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}

/**
 * The hosting platform's page-view script. A host that deploys the viewer
 * elsewhere, or does not want the script, switches it off (`lib/features`);
 * it is then never injected, so the page makes no request for it. Neither is
 * it injected for a visitor who opted out of analytics, or before the
 * first-visit notice was shown.
 */
export function HostingAnalytics() {
  const enabled = isFeatureEnabled('privacy.vercel-analytics');
  const allowed = useSyncExternalStore(subscribeAnalyticsConsent, hostingAnalyticsAllowed, () => false);
  return enabled && allowed ? <Analytics beforeSend={hostingAnalyticsBeforeSend} /> : null;
}
