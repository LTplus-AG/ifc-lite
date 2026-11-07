/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '@/i18n';
import { PaletteLauncherContext } from './command-palette-launcher';
import { PALETTE_DIALOG_LAYOUT, PALETTE_DIALOG_TOP } from './command-palette-layout';

type PaletteLoad = { module: typeof import('./CommandPalette') } | { error: unknown };

type CommandPaletteHostProps = ComponentProps<typeof import('./CommandPalette')['CommandPalette']>;

export function CommandPaletteHost(props: CommandPaletteHostProps) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [pendingQuery, setPendingQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [load, setLoad] = useState<PaletteLoad | null>(null);
  const launcher = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (props.open) launcher.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [props.open]);
  useEffect(() => {
    if (props.open) setOpened(true);
    else { setPendingQuery(''); setComposing(false); }
  }, [props.open]);
  useEffect(() => {
    if (!opened) return;
    let current = true;
    void import('./CommandPalette').then(
      module => { if (current) setLoad({ module }); },
      error => { if (current) setLoad({ error }); },
    );
    return () => { current = false; };
  }, [opened]);

  // Start loading on the first open, then retain the export dialog's owner
  // when a command closes the palette (#8947).
  if (!props.open && !opened) return null;

  return (
    <PaletteLauncherContext.Provider value={launcher}>
    <ChunkErrorBoundary label="Command palette" renderFallback={fallback => (
      <PaletteLoadDialog {...props}>{fallback}</PaletteLoadDialog>
    )}>
      {!load || composing ? <PaletteLoadDialog {...props}>
        <input type="search" aria-label={t('commandPalette.searchAriaLabel')}
          placeholder={t('commandPalette.searchPlaceholder')} value={pendingQuery}
          onChange={event => setPendingQuery(event.currentTarget.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={event => {
            setPendingQuery(event.currentTarget.value);
            setComposing(false);
          }}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autoComplete="off" spellCheck={false} />
        <output className="text-sm text-muted-foreground">{t('shellChrome.statusBar.loadingFallback')}</output>
      </PaletteLoadDialog> : 'error' in load ? <PaletteLoadFailure error={load.error} /> :
        <load.module.CommandPalette {...props} initialQuery={pendingQuery} />}

    </ChunkErrorBoundary>
    </PaletteLauncherContext.Provider>
  );
}

/** Surface the original import failure through the existing chunk error boundary. */
function PaletteLoadFailure({ error }: { error: unknown }): never { throw error; }

/** Loading and failure remain cancellable without unmounting the loaded export owner. */
function PaletteLoadDialog({ open, onOpenChange, children }: CommandPaletteHostProps & { children: ReactNode }) {
  const { t } = useTranslation();
  const launcher = useContext(PaletteLauncherContext);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent overlayClassName="z-(--z-command-palette)"
        className={PALETTE_DIALOG_LAYOUT}
        style={{ top: PALETTE_DIALOG_TOP }} aria-describedby={undefined}
        onCloseAutoFocus={event => {
          event.preventDefault();
          // While open, the loaded palette owns the next focus scope. A true
          // dismissal has no Radix trigger: restore the captured launcher.
          if (!open && launcher?.current?.isConnected) launcher.current.focus();
        }}
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
