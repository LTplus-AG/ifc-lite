/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { Cloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BCFServerDialog } from './BCFServerDialog';

/** Header control that owns the BCF server dialog's open state. */
export function BCFServerControl() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setOpen(true)}
        title="BCF server"
      >
        <Cloud className="h-4 w-4" />
      </Button>
      <BCFServerDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
