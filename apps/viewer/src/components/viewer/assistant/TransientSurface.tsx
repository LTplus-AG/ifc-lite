/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type ReactNode } from 'react';
import { useTransientSurface } from './useTransientSurface';

/** A labelled inline region with the Assistant's open / Escape / restore-focus contract. */
export function TransientSurface({ label, onClose, fallback, children }: {
  label: string; onClose: () => void; fallback?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useTransientSurface(ref, onClose, { fallback });
  return <div ref={ref} role="group" aria-label={label} tabIndex={-1} className="outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
    {children}
  </div>;
}
