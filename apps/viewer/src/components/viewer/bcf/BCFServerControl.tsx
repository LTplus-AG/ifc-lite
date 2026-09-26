/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { Cloud } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useTranslation } from '@/i18n';
import { BCFServerDialog } from './BCFServerDialog';

/** Header control that owns the BCF server dialog's open state. */
export function BCFServerControl() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        label={t('bcf.serverControl.title')}
        className="h-7 w-7"
        onClick={() => setOpen(true)}
      >
        <Cloud className="h-4 w-4" />
      </IconButton>
      <BCFServerDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
