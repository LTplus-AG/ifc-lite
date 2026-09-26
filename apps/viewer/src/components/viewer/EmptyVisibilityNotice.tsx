/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EyeOff } from 'lucide-react';
import { HudItem, HudNotice } from '@/components/viewport-ui/hud';
import { useTranslation } from '@/i18n';
import { activeVisibilityReasons, resetVisibilityReasons } from '@/lib/visibility/visibility-reasons';
import { getViewerStoreApi } from '@/store';

/** Explains a loaded but empty effective view, with the same reset as Show All. */
export function EmptyVisibilityNotice({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  const store = getViewerStoreApi();
  const reasons = activeVisibilityReasons(store.getState()).map((reason) => t(reason.labelKey));
  return (
    <HudItem region="top-center" order={13}>
      <HudNotice
        tone="warn"
        icon={<EyeOff className="h-4 w-4" aria-hidden />}
        title={t('visibilityEmpty.title')}
        description={reasons.length > 0 ? t('visibilityEmpty.reasons', { reasons: reasons.join(', ') }) : undefined}
        action={{
          label: t('visibilityEmpty.reset'),
          onClick: () => resetVisibilityReasons(store),
        }}
      />
    </HudItem>
  );
}
