/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useState } from 'react';

const RegistrySource = lazy(() => import('./RegistrySource').then(module => ({ default: module.RegistrySource })));
const OciPushTo = lazy(() => import('./OciPushTo').then(module => ({ default: module.OciPushTo })));

export function RegistrySources({ catalogEnabled, expanded, navigationDisabled, onBusyChange, onToggle }: {
  catalogEnabled: boolean;
  expanded: boolean;
  navigationDisabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onToggle: () => void;
}) {
  const [browserBusy, setBrowserBusy] = useState(false);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const busy = browserBusy || publicationBusy;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  return <Suspense fallback={null}>
    {catalogEnabled && <RegistrySource expanded={expanded} navigationDisabled={navigationDisabled || publicationBusy}
      onBusyChange={setBrowserBusy} onToggle={onToggle} />}
    <li className="rounded border p-3">
      <OciPushTo disabled={navigationDisabled || browserBusy} onBusyChange={setPublicationBusy} />
    </li>
  </Suspense>;
}
