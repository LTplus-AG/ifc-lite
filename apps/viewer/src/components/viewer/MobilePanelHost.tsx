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

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useViewerStore } from '@/store';
import { mobilePanelHost } from '@/lib/layout/form-factor';
import { MobileBottomSheet } from './MobileBottomSheet';
import { moveMobilePanel } from './move-mobile-panel';

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
  const anchor = useRef<HTMLDivElement>(null);
  // React always portals into this same node. Only its DOM placement changes,
  // preserving child-local state and the frame's scroll container (#9718).
  const [container] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    const parent = host === 'sheet' ? anchor.current : slot ?? anchor.current;
    container.className = host === 'sheet'
      ? 'absolute inset-0 pointer-events-none'
      : 'flex min-h-0 flex-1 flex-col';
    if (parent) moveMobilePanel(parent, container);
  }, [container, host, slot]);
  useLayoutEffect(() => () => container.remove(), [container]);
  return <>
    <div ref={anchor} className="contents" />
    {createPortal(
      <MobileBottomSheet title={title} onClose={onClose} pane={host === 'sheet' ? undefined : host}>
        {children}
      </MobileBottomSheet>, container)}
  </>;
}
