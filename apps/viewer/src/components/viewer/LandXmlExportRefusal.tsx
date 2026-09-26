/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import { AlertCircle, FileCheck2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { buildExportFilename, downloadBlob, stripExtension } from '@/lib/export/download';
import { trackExportCompleted } from '@/lib/analytics';
import { useTranslation } from '@/i18n';
import type { LandXmlExportPlan } from '@/lib/export/landXmlIfcPlan.js';

interface LandXmlExportRefusalProps {
  /** What the mapping can and cannot do with the LandXML models in scope. */
  plan: LandXmlExportPlan;
  /** False when the chosen schema is not a mapping target (v1 derives IFC4X3 only). */
  schemaSupported: boolean;
  /**
   * Frozen snapshot of the bytes as picked. Absent for cache-restored models,
   * which is why the source route is offered conditionally rather than assumed.
   */
  sourceFile?: File;
}

/**
 * What the LandXML→IFC mapping will do with the records in scope, shown before
 * the user commits.
 *
 * Two shapes, and which one appears is the whole point (#4937 §6):
 *
 * - **Covered** — the conversion is announced by record count, together with
 *   every family that will NOT be included and any assumption in force. A
 *   partial export is allowed; a SILENT partial is not.
 * - **Not covered** — the refusal, with the source-format route it points at.
 *   #5175: the refusal text already said "export the original LandXML file
 *   instead" while no such action existed anywhere in the viewer. Offering the
 *   retained source bytes is what makes the refusal honest rather than a dead
 *   end.
 */
export function LandXmlExportRefusal({ plan, schemaSupported, sourceFile }: LandXmlExportRefusalProps) {
  const { t } = useTranslation();
  // The source route is offered only for the model the dialog has SELECTED: in
  // a merged export the LandXML model may not be the one on screen, and
  // handing back another model's bytes would be the wrong file.
  const isLandXmlSelected = plan.scope === 'selected';
  const records = [
    ...(plan.surfaces > 0 ? [t('exportDialog.landXml.convertSurfaces', { count: plan.surfaces })] : []),
    ...(plan.surveyPoints > 0 ? [t('exportDialog.landXml.convertPoints', { count: plan.surveyPoints })] : []),
    ...(plan.alignments > 0 ? [t('exportDialog.landXml.convertAlignments', { count: plan.alignments })] : []),
  ].join(', ');
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
    trackExportCompleted({ format: 'xml', surface: 'landxml_refusal' });
  }, [sourceFile]);

  if (plan.covered && schemaSupported) {
    return (
      <Alert>
        <FileCheck2 className="h-4 w-4" />
        <AlertTitle>{t('exportDialog.landXml.convertTitle')}</AlertTitle>
        <AlertDescription>
          <div>{t('exportDialog.landXml.convertSummary', { records })}</div>
          {/* Named, never silently dropped — the families are the vocabulary
              the mapping spec refuses in. */}
          {plan.refusals.length > 0 && (
            <div className="mt-2">
              <div className="font-medium">{t('exportDialog.landXml.excludedTitle')}</div>
              <ul className="list-disc pl-4">
                {plan.refusals.map((refusal) => (
                  <li key={refusal.family}>{refusal.message}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.assumedUnit !== null && (
            <div className="mt-2">{t('exportDialog.landXml.assumedUnit', { unit: plan.assumedUnit })}</div>
          )}
          {plan.missingCrs && <div className="mt-2">{t('exportDialog.landXml.missingCrs')}</div>}
          {/* A declared CRS is written but UNVERIFIED: §2.2's transposition
              check needs bounds this repo deliberately does not resolve, so a
              mirrored source is not detectable here. Stated, not implied. */}
          {plan.crsName !== null && (
            <div className="mt-2">{t('exportDialog.landXml.declaredCrs', { crs: plan.crsName })}</div>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{t('exportDialog.landXml.title')}</AlertTitle>
      <AlertDescription>
        {/* A source refused only for its target schema or its scope is a
            different problem with a different fix, and saying "no IFC entities
            are synthesized" there would be false. */}
        {plan.covered ? t('exportDialog.landXml.schemaUnsupported')
          : plan.mergedUnsupported ? t('exportDialog.landXml.mergedUnsupported')
          : t('exportDialog.landXml.description')}
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
