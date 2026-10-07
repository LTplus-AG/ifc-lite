/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Follow a `?panel=` / artifact deep link once on load (#6927). The link's
 * parameters are removed from the address bar afterwards so a reload does not
 * replay it; other parameters (`?model=`, `?room=`) are left alone.
 */

import { useEffect, useRef } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { getViewerStoreApi } from '@/store';
import { parseDeepLink, withoutDeepLink } from '@/lib/deep-links/artifact-link';
import { resolveDeepLink } from '@/lib/deep-links/resolve-artifact-link';
import { deepLinkMessage } from '@/lib/deep-links/deep-link-message';

export function useArtifactDeepLink(): void {
  const { t } = useTranslation();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || typeof window === 'undefined') return;
    handled.current = true;
    const link = parseDeepLink(window.location.search);
    if (!link) return;
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${withoutDeepLink(search)}${hash}`);
    resolveDeepLink(getViewerStoreApi(), link).then((outcome) => {
      const message = deepLinkMessage(outcome);
      if (message) toast.error(t(message.key, message.params));
    }).catch((error: unknown) => {
      console.error('[deep-link] resolving the link failed:', error);
      toast.error(t('workspaceMigration.deepLink.failed'));
    });
  }, [t]);
}
