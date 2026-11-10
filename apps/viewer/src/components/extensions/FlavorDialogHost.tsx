/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { FlavorDialog } from './FlavorDialog';

/** One persistent destination, independent of desktop status-bar visibility (#8947). */
export function FlavorDialogHost() {
  const [open, setOpen] = useState(false);
  const requested = useViewerStore(state => state.flavorDialogRequested);
  const setRequested = useViewerStore(state => state.setFlavorDialogRequested);
  useEffect(() => {
    if (!requested) return;
    setOpen(true);
    setRequested(false);
  }, [requested, setRequested]);
  return <FlavorDialog open={open} onClose={() => setOpen(false)} />;
}
