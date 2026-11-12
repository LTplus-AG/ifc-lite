/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { refreshToastDialogs, registerToastDialog } from './toast-store';

const ToastDialogContext = React.createContext<{ id: string; ancestors: readonly string[]; modal: boolean; open: boolean }>({
  id: '', ancestors: [], modal: false, open: false,
});
export const useToastDialog = () => React.useContext(ToastDialogContext);

/** #9875: notices belong to the modal active when they are raised. */
export function Dialog({ open: controlledOpen, defaultOpen = false, modal = true, onOpenChange, ...props }:
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const id = React.useId();
  const parent = useToastDialog();
  const ancestors = React.useMemo(() => parent.id ? [...parent.ancestors, parent.id] : [], [parent.id, parent.ancestors]);
  // Establish ownership before descendants' layout effects can raise notices.
  // Registration does not notify React; the ordinary layout effect does that.
  React.useInsertionEffect(() => {
    if (open && modal) return registerToastDialog(id, ancestors);
  }, [id, ancestors, open, modal]);
  React.useLayoutEffect(() => {
    refreshToastDialogs();
    return refreshToastDialogs;
  }, [id, ancestors, open, modal]);
  return (
    <ToastDialogContext.Provider value={{ id, ancestors, modal, open }}>
      <DialogPrimitive.Root {...props} open={open} modal={modal} onOpenChange={(next) => {
        if (controlledOpen === undefined) setLocalOpen(next);
        onOpenChange?.(next);
      }} />
    </ToastDialogContext.Provider>
  );
}
