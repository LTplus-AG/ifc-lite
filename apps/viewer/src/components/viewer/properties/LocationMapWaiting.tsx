/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Spinner } from '@/components/ui/spinner';

export function LocationMapWaiting({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center h-[180px] bg-muted">
      <Spinner size="md" className="text-muted-foreground" />
      <span className="text-xs text-muted-foreground ml-2">{label}</span>
    </div>
  );
}
