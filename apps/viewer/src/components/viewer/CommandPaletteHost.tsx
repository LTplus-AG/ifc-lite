/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';

const CommandPalette = lazy(() => import('./CommandPalette').then(module => ({ default: module.CommandPalette })));

type CommandPaletteHostProps = ComponentProps<typeof import('./CommandPalette')['CommandPalette']>;

export function CommandPaletteHost(props: CommandPaletteHostProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (props.open) setOpened(true);
  }, [props.open]);

  // Start loading on the first open, then retain the export dialog's owner
  // when a command closes the palette (#8947).
  if (!props.open && !opened) return null;

  return (
    <ChunkErrorBoundary label="Command palette" renderFallback={fallback => (
      <PaletteLoadDialog {...props}>{fallback}</PaletteLoadDialog>
    )}>
      <Suspense fallback={<PaletteLoadDialog {...props}>
        <output className="text-sm text-muted-foreground">{t('shellChrome.statusBar.loadingFallback')}</output>
      </PaletteLoadDialog>}>
        <CommandPalette {...props} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}

/** Loading and failure remain cancellable without unmounting the loaded export owner. */
function PaletteLoadDialog({ open, onOpenChange, children }: CommandPaletteHostProps & { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent overlayClassName="z-(--z-command-palette)"
        className="z-(--z-command-palette) translate-y-0 w-[calc(100%_-_2rem)] max-w-lg rounded-lg"
        style={{ top: 'min(12dvh, 96px)' }} aria-describedby={undefined}
        onCloseAutoFocus={event => { if (open) event.preventDefault(); }}
        onEscapeKeyDown={event => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
          event.stopPropagation();
        }}>
        <DialogTitle>{t('commandPalette.ariaLabel')}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
