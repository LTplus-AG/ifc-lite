/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { clashGroupLibrary, useClashGroupLibrary, DEFAULT_GROUP_WORKSPACE } from '@/lib/clash/group-workspace';
import { ContentStorageNotice } from './ContentStorageNotice';

/** Imported conflicting partitions stay independent until the coordinator selects one. */
export function ClashGroupStorage() {
  const { t } = useTranslation();
  const library = useClashGroupLibrary();
  const options = library.entries.some(entry => entry.id === DEFAULT_GROUP_WORKSPACE)
    ? library.entries : [{ id: DEFAULT_GROUP_WORKSPACE, name: t('clashGroups.defaultWorkspace') }, ...library.entries];
  return <div className="border-b border-border text-xs">
    <label className="flex items-center gap-2 px-2 py-1">
      {t('clashGroups.workspace')}
      <select className="min-w-0 flex-1 rounded border border-border bg-background" value={library.activeId}
        disabled={library.status.phase !== 'ready'} onChange={event => useClashGroupLibrary.setState({ activeId: event.target.value })}>
        {options.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id.slice(0, 8)}</option>)}
      </select>
    </label>
    <ContentStorageNotice status={library.status} retry={clashGroupLibrary.retry} restore={clashGroupLibrary.restore} />
  </div>;
}
