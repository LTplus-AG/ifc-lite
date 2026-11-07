/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { SearchInline } from './SearchInline';

/** Keep one real field owner mounted on phones, including while closed (#8947).
 * ViewerLayout mounts this OR the ribbon, so keyboard owners never overlap. */
export function MobileSearchInline() {
  const visible = useViewerStore(s => s.searchOpen || s.searchVimCycle !== null);
  return <div hidden={!visible} className="relative z-50 border-b border-divider bg-panel p-2">
    <SearchInline compact />
  </div>;
}
