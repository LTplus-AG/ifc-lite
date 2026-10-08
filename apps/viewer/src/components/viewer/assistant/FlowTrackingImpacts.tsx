/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import type { TrackingImpact } from '@/lib/assistant/flow-tracking';

const EFFECT_KEY = {
  removed: 'flowAssistant.trackingRemoved', rekeyed: 'flowAssistant.trackingRekeyed', mode: 'flowAssistant.trackingMode',
  branch: 'flowAssistant.trackingBranch', added: 'flowAssistant.trackingAdded',
} as const;

/** Native tracking effects of a reviewed graph change, with the ownership rule they follow. */
export function FlowTrackingImpacts({ impacts }: { impacts: readonly TrackingImpact[] }) {
  const { t } = useTranslation();
  if (!impacts.length) return null;
  return <div role="alert" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
    <p className="font-semibold">{t('flowAssistant.trackingTitle')}</p>
    <ul className="list-disc pl-4 space-y-0.5">
      {impacts.map(impact => <li key={`${impact.nodeId}:${impact.effect}`} className="break-words">{t(EFFECT_KEY[impact.effect], {
        node: impact.nodeId, key: impact.trackingKey, next: impact.nextTrackingKey ?? '', mode: impact.mode ?? '',
        owned: impact.ownedElements === null ? t('flowAssistant.ownedUnknown') : t('flowAssistant.owned', { count: impact.ownedElements }),
      })}</li>)}
    </ul>
    <p className="text-muted-foreground">{t('flowAssistant.trackingOwnership')}</p>
  </div>;
}
