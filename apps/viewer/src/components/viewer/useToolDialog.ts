/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';

/** Controlled hosts omit the trigger; standalone consumers keep their own. */
export interface ToolDialogProps {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}
export function useToolDialog(props: ToolDialogProps) {
  const [local, setLocal] = useState(false);
  return [props.open ?? local, props.onOpenChange ?? setLocal] as const;
}
