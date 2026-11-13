/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useState } from 'react';
import { useViewerStore } from '@/store';

// The dialog (and the flavor storage, import and diff code under it) loads on
// first open, not with the page (#9296 eager-JS headroom).
const FlavorDialog = lazy(() => import('./FlavorDialog').then(m => ({ default: m.FlavorDialog })));

/** One persistent destination, independent of desktop status-bar visibility (#8947). */
export function FlavorDialogHost() {
  const [open, setOpen] = useState(false);
  // Stays mounted after the first open so later closes keep their animation.
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true);
  const requested = useViewerStore(state => state.flavorDialogRequested);
  const setRequested = useViewerStore(state => state.setFlavorDialogRequested);
  useEffect(() => {
    if (!requested) return;
    setOpen(true);
    setRequested(false);
  }, [requested, setRequested]);
  if (!mounted) return null;
  return <Suspense fallback={null}><FlavorDialog open={open} onClose={() => setOpen(false)} /></Suspense>;
}
