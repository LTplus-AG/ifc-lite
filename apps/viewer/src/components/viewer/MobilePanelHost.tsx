/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one host every mobile panel renders through (#9718): Hierarchy, the
 * single-panel sheet (`MobilePanelSheet`) and the Panels list
 * (`MobilePanelLauncher`). The panel bodies do not change; only their frame does,
 * by `mobilePanelHost(formFactor)`:
 * - `sheet`: the modal `MobileBottomSheet`, in place over the model.
 * - `side-pane` / `segment`: a non-modal pane, portalled into the slot the
 *   mobile shell docks beside the viewport or in a fold's other segment
 *   (`MobileShell`). Nothing covers the model, so orbit and selection keep
 *   working and an open Properties pane follows the selection live.
 *
 * Where the host changes live (rotating, folding, unfolding) the panel stays
 * open: which panel is open is store state; only the frame is swapped.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useViewerStore } from '@/store';
import { mobilePanelHost } from '@/lib/layout/form-factor';
import { MobileBottomSheet, MobilePanelHeader } from './MobileBottomSheet';

/**
 * The docked pane's slot, provided by the mobile shell. `undefined` outside a
 * shell (a host mounted on its own in a test), where the pane renders in place;
 * `null` while the shell's slot is not mounted yet, where it renders nothing.
 */
const MobilePaneSlot = createContext<HTMLElement | null | undefined>(undefined);
export const MobilePaneSlotProvider = MobilePaneSlot.Provider;

export function MobilePanelHost({ title, onClose, children }: {
  title: ReactNode;
  /** Omitted for the Panels list shown inline in a fold, which has nothing to close. */
  onClose?: () => void;
  children: ReactNode;
}) {
  const host = useViewerStore((s) => mobilePanelHost(s.formFactor));
  const slot = useContext(MobilePaneSlot);
  if (host === 'sheet') {
    return <MobileBottomSheet title={title} onClose={onClose ?? noop}>{children}</MobileBottomSheet>;
  }
  const pane = (
    <section data-mobile-pane={host} aria-label={typeof title === 'string' ? title : undefined} className="flex min-h-0 flex-1 flex-col bg-background">
      <MobilePanelHeader title={title} onClose={onClose} className="pt-2 border-b" />
      <div className="flex-1 min-h-0 overflow-auto overscroll-contain">{children}</div>
    </section>
  );
  if (slot === undefined) return pane;
  return slot ? createPortal(pane, slot) : null;
}

function noop(): void {}
