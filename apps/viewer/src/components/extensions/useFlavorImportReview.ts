/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnpackedFlavor } from '@ifc-lite/extensions';
import type { ExtensionHostService } from '@/services/extensions/host';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { flavorFailure } from './flavor-dialog-feedback';

type Review = { bytes: Uint8Array; unpacked: UnpackedFlavor };
/** One flavor file owns preview until it is dismissed or its dialog closes. */
export function useFlavorImportReview(host: ExtensionHostService, open: boolean) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<Review | null>(null);
  const previewRef = useRef<Review | null>(null);
  const { busy, run, release } = useSingleFlight();
  const clearPreview = useCallback(() => {
    previewRef.current?.bytes.fill(0);
    previewRef.current = null;
    setPreview(null);
  }, []);
  useEffect(() => () => { release(); clearPreview(); }, [open, release, clearPreview]);
  async function handleFiles(files: FileList | null) {
    if (!files?.length || previewRef.current) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.iflv')) {
      toast.error(t('extensionsFlavors.flavorDialog.toast.expectedFile', { filename: file.name })); return;
    }
    await run(async isCurrent => {
      let bytes: Uint8Array | undefined, adopted = false;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
        if (!isCurrent()) return;
        const unpacked = await host.flavors.preview(bytes);
        if (!isCurrent()) return;
        previewRef.current = { bytes, unpacked };
        setPreview(previewRef.current); adopted = true;
      } catch (error) {
        if (isCurrent()) toast.error(flavorFailure(t, t('extensionsFlavors.flavorDialog.operation.preview'), error));
      } finally { if (bytes && !adopted) bytes.fill(0); }
    });
  }
  return { preview, clearPreview, handleFiles, busy };
}
