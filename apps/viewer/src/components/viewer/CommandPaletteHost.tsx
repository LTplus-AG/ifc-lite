/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useState, type ComponentProps } from 'react';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';

const CommandPalette = lazy(() => import('./CommandPalette').then(module => ({ default: module.CommandPalette })));

type CommandPaletteHostProps = ComponentProps<typeof import('./CommandPalette')['CommandPalette']>;

export function CommandPaletteHost(props: CommandPaletteHostProps) {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (props.open) setOpened(true);
  }, [props.open]);

  // Start loading on the first open, then retain the export dialog's owner
  // when a command closes the palette (#8947).
  if (!props.open && !opened) return null;

  return (
    <ChunkErrorBoundary label="Command palette">
      <Suspense fallback={null}>
        <CommandPalette {...props} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
