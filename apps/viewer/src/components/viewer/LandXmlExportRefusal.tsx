/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { buildExportFilename, downloadBlob, stripExtension } from '@/lib/export/download';
import { useTranslation } from '@/i18n';

interface LandXmlExportRefusalProps {
  /** True when the model the dialog has selected is itself a LandXML source. */
  isLandXmlSelected: boolean;
  /**
   * Frozen snapshot of the bytes as picked. Absent for cache-restored models,
   * which is why the source route is offered conditionally rather than assumed.
   */
  sourceFile?: File;
}

/**
 * The refusal shown when IFC export is declined because LandXML records are in
 * scope, together with the source-format route it points at.
 *
 * #5175: the refusal text already told users to "export the original LandXML
 * file instead", but no such action existed anywhere in the viewer — the
 * message promised something the UI could not do. Offering the retained source
 * bytes here is what makes the refusal honest rather than a dead end.
 */
export function LandXmlExportRefusal({ isLandXmlSelected, sourceFile }: LandXmlExportRefusalProps) {
  const { t } = useTranslation();
  const handleDownloadSource = useCallback(() => {
    if (!sourceFile) return;
    // Keep the producer's own extension rather than assuming `.xml`; a LandXML
    // source may legitimately arrive as `.landxml`.
    const dot = sourceFile.name.lastIndexOf('.');
    const extension = dot > 0 ? sourceFile.name.slice(dot) : '.xml';
    downloadBlob(
      sourceFile,
      buildExportFilename(stripExtension(sourceFile.name) || 'landxml-source', extension),
    );
  }, [sourceFile]);

  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{t('exportDialog.landXml.title')}</AlertTitle>
      <AlertDescription>
        {t('exportDialog.landXml.description')}
        {isLandXmlSelected && (
          sourceFile ? (
            <div className="mt-2">
              <Button type="button" variant="outline" size="sm" onClick={handleDownloadSource}>
                {t('exportDialog.landXml.downloadSource')}
              </Button>
            </div>
          ) : (
            <div className="mt-2">{t('exportDialog.landXml.sourceUnavailable')}</div>
          )
        )}
      </AlertDescription>
    </Alert>
  );
}
