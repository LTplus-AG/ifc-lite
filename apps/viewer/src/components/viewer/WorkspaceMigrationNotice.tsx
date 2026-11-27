/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Suspense } from 'react';
import { lazyChunk } from '@/lib/lazy-chunk';
import { useViewerStore } from '@/store';

const LayoutMigrationNotice = lazyChunk(() => import('./sidebar/LayoutMigrationNotice')
  .then(module => ({ default: module.LayoutMigrationNotice })));

/** Recovery remains reachable on mobile and when the sidebar is collapsed (#7054). */
export function WorkspaceMigrationNotice() {
  const pending = useViewerStore(state => state.layoutMigrationChanges.length > 0);
  return pending ? <Suspense fallback={null}><LayoutMigrationNotice /></Suspense> : null;
}
