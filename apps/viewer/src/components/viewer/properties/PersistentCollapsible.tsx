/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { Collapsible } from '@/components/ui/collapsible';
import { usePersistentDisclosure } from './usePersistentDisclosure';

export function PersistentCollapsible({ id, forceOpen = false, className, children }: {
  id: string;
  forceOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistentDisclosure(id);
  return (
    <Collapsible open={forceOpen || open} onOpenChange={forceOpen ? undefined : setOpen} className={className}>
      {children}
    </Collapsible>
  );
}
