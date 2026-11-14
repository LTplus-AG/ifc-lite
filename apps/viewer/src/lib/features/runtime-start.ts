/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a page applies the host's configuration: the viewer's
 * `mountViewer` and the embed entry both call it, once, before the first
 * render. With no configuration every feature is on. The viewer then starts
 * its locale with the configuration's `locale`; the embed has no translations.
 *
 * Analytics start here and nowhere else, after the feature set is fixed, so
 * a host that switches them off never contacts the analytics service.
 */

import { startAnalytics } from '@/lib/analytics';
import { applyFeatureSelection } from './index';
import { parseViewerRuntimeConfig, type ViewerRuntimeConfig } from './runtime-config';

/**
 * Every configuration goes through the same check, whether it was fetched or
 * handed over by a host's own entry: an invalid one throws (fail closed)
 * instead of being read as "everything on". Returns the checked object, the
 * one the caller reads anything else (the locale) from.
 */
export function applyRuntimeConfig(config?: unknown): ViewerRuntimeConfig | undefined {
  const checked = config === undefined ? undefined : parseViewerRuntimeConfig(config);
  applyFeatureSelection(checked?.features);
  startAnalytics();
  return checked;
}
