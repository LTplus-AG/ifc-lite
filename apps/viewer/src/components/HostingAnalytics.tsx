/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Analytics } from '@vercel/analytics/react';
import { isFeatureEnabled } from '@/lib/features';

/**
 * The hosting platform's page-view script. A host that deploys the viewer
 * elsewhere, or does not want the script, switches it off (`lib/features`);
 * it is then never injected, so the page makes no request for it.
 */
export function HostingAnalytics() {
  return isFeatureEnabled('privacy.vercel-analytics') ? <Analytics /> : null;
}
