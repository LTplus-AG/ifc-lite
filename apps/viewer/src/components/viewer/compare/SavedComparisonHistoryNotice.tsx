/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { ContentStorageNotice } from '../ContentStorageNotice';

export function SavedComparisonHistoryNotice() {
  const status = useViewerStore((s) => s.savedComparisonsStorage);
  const retry = useViewerStore((s) => s.retrySaveComparisons);
  return <ContentStorageNotice status={status} restore={() => useViewerStore.getState().restoreSavedComparisons()} retry={retry} />;
}
