/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { openGeorefSection } from '@/lib/site-context/site-context-command';

export function ExportGeorefNotice({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const { t } = useTranslation();
  return <Alert>
    <AlertDescription>{t('geometryExport.shared.georefRequired')}</AlertDescription>
    <Button variant="outline" size="sm" className="mt-2" onClick={() => {
      onClose();
      openGeorefSection(modelId, 'addGeoref', 'programmatic');
    }}>{t('geometryExport.shared.openGeoreferencing')}</Button>
  </Alert>;
}
