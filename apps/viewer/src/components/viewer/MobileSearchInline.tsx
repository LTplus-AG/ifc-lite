/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import X from '~icons/lucide/x';
import { SearchInline } from './SearchInline';

/** Keep one real field owner mounted on phones, including while closed (#8947).
 * ViewerLayout mounts this OR the ribbon, so keyboard owners never overlap. */
export function MobileSearchInline() {
  const { t } = useTranslation();
  const close = () => {
    const state = useViewerStore.getState();
    state.exitVimCycle();
    state.closeSearch();
  };
  const visible = useViewerStore(s => s.searchOpen || s.searchVimCycle !== null);
  return <div hidden={!visible} className="relative z-50 border-b border-divider bg-panel p-2">
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1"><SearchInline compact /></div>
      <button type="button" aria-label={t('viewerShell.dialog.close')} onClick={close}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded hover:bg-hover focus-visible:outline focus-visible:outline-2">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  </div>;
}
