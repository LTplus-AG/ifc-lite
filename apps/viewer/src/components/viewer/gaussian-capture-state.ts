/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GaussianCaptureState } from '@/hooks/ingest/gaussianAssets';
import type { TranslationKey } from '@/i18n';

/**
 * The user-facing text for a capture's renderer state (#8566). A failed
 * handle is terminal, so each failure names its fix and then the reload; a
 * capture that merely moved stays resident and needs no message at all.
 */
export function gaussianStateLabel(state: GaussianCaptureState): { key: TranslationKey; values?: Record<string, string> } {
  switch (state.state) {
    case 'resident': return { key: 'gaussianCapture.state.resident' };
    case 'pending': return { key: 'gaussianCapture.state.pending' };
    case 'invalid': return { key: state.reason === 'renderer-replaced' ? 'gaussianCapture.state.replaced' : 'gaussianCapture.state.invalid' };
    case 'failed':
      if (state.reason === 'reload-required') return { key: 'gaussianCapture.state.failedReload' };
      if (state.reason === 'anchor-extent') return { key: 'gaussianCapture.state.failedAnchor' };
      return { key: 'gaussianCapture.state.failedOther', values: { reason: state.reason } };
  }
}
