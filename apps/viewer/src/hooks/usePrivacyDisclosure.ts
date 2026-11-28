/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `usePrivacyDisclosure` — show the privacy disclosure once per browser.
 *
 * Fires a one-time toast on first launch after the extensions
 * subsystem (action log + miner) is alive. Persists the
 * acknowledgement under a localStorage flag so users only see the
 * disclosure once. The toast opens Settings → Privacy for the full controls.
 *
 * The disclosure is required by RFC §06 §7 — users must be told what
 * gets stored locally before the miner / memory loops start. Analytics wait
 * for it too: PostHog and the hosting page-view script start only once
 * `markPrivacyNoticeShown` has run (lib/analytics-consent).
 */

import { isFeatureEnabled } from '@/lib/features';
import { useEffect } from 'react';
import { toast } from '@/components/ui/toast';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useTranslation } from '@/i18n';
import { openSettings } from '@/lib/settings/open-settings';
import { isPrivacyNoticeShown, markPrivacyNoticeShown } from '@/lib/analytics-consent';

const PRIVACY_GUIDE_URL = 'https://github.com/LTplus-AG/ifc-lite/blob/main/docs/guide/privacy.md';

/**
 * `standalone`: for pages outside the viewer (`/mcp`, `/mcp/playground`). They
 * have no extension host and no Settings dialog, so the notice shows without
 * waiting for the host and its action opens the privacy guide. Analytics on
 * those pages start after it, as in the viewer.
 */
export function usePrivacyDisclosure(options: { standalone?: boolean } = {}): void {
  const standalone = options.standalone === true;
  const host = useOptionalExtensionHost();
  const { t } = useTranslation();
  useEffect(() => {
    if (!isFeatureEnabled('privacy.notice') || (!host && !standalone)) return;
    if (typeof window === 'undefined') return;
    if (isPrivacyNoticeShown()) return;
    // Defer slightly so the toast doesn't fight with the splash UI.
    const handle = window.setTimeout(() => {
      toast.info(t('settings.privacy.toastDisclosure'), standalone
        ? { label: t('settings.privacy.learnMore'), onClick: () => { window.open(PRIVACY_GUIDE_URL, '_blank', 'noopener,noreferrer'); } }
        : { label: t('settings.privacy.toastAction'), onClick: () => openSettings('privacy') });
      markPrivacyNoticeShown();
    }, 3500);
    return () => window.clearTimeout(handle);
  }, [host, t, standalone]);
}
