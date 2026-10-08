/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lists extension contributions that no viewer surface renders, with the
 * reason (#6927). A placement is never dropped silently: an unrendered
 * catalogue slot, a host-owned AI surface and an unknown slot id each say so.
 */

import { useEffect, useState } from 'react';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useTranslation } from '@/i18n';
import { unavailablePlacements, type PlacementReason, type UnavailablePlacement } from '@/lib/extensions/slot-placements';

const REASON_KEY = {
  'not-rendered': 'workspaceMigration.placement.notRendered',
  'host-owned': 'workspaceMigration.placement.hostOwned',
  'unknown-slot': 'workspaceMigration.placement.unknownSlot',
} as const satisfies Record<PlacementReason, string>;

export function UnavailablePlacements() {
  const { t } = useTranslation();
  const host = useOptionalExtensionHost();
  const [items, setItems] = useState<UnavailablePlacement[]>([]);
  useEffect(() => {
    if (!host) { setItems([]); return; }
    const refresh = () => setItems(unavailablePlacements(host.slotRegistry));
    refresh();
    return host.onChange(refresh);
  }, [host]);
  if (items.length === 0) return null;
  return <section aria-label={t('workspaceMigration.placement.title')} className="border-b bg-muted/30 px-4 py-2 text-xs space-y-1">
    <h3 className="font-medium">{t('workspaceMigration.placement.title')}</h3>
    <ul className="space-y-1">
      {items.map((item, index) => <li key={`${item.extensionId}:${item.slot}:${index}`}>
        <span className="font-mono">{item.extensionId}</span>{item.label && <> · {item.label}</>}
        <span className="block text-muted-foreground">{t(REASON_KEY[item.reason], { slot: item.slot })}</span>
      </li>)}
    </ul>
  </section>;
}
