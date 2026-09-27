/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExportDialog.tsx` (#5848 shell migration): the LandXML refusal banner,
 * schema selector, schema-conversion warning, and output-format indicator —
 * extracted verbatim, purely presentational. Every gating condition and every
 * piece of state still lives in `ExportDialog.tsx`.
 */

import { ArrowUp, ArrowDown } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTranslation } from '@/i18n';
import { LandXmlExportRefusal } from './LandXmlExportRefusal.js';
import type { LandXmlExportPlan } from '@/lib/export/landXmlIfcPlan.js';
import type { ExportOutputInfo } from './export-output-format.js';

type SchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

export interface ExportDialogSchemaOptionsProps {
  landXmlPlan: LandXmlExportPlan | null;
  changesOnly: boolean;
  isIfc5: boolean;
  schema: SchemaVersion | '';
  setSchema: (schema: SchemaVersion) => void;
  sourceFile: File | undefined;
  sourceSchema: string;
  schemaConversion: 'upgrade' | 'downgrade' | null;
  outputInfo: ExportOutputInfo;
}

/** Schema selector, LandXML refusal banner, conversion warning, output format. */
export function ExportDialogSchemaOptions({
  landXmlPlan,
  changesOnly,
  isIfc5,
  schema,
  setSchema,
  sourceFile,
  sourceSchema,
  schemaConversion,
  outputInfo,
}: ExportDialogSchemaOptionsProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* Schema selector — this drives the output format */}
      {/* Only where an IFC-family file is synthesised: a changes-only JSON
          delta is source-independent, so neither branch applies to it. */}
      {landXmlPlan && (!changesOnly || isIfc5) && (
        <LandXmlExportRefusal
          plan={landXmlPlan} schemaSupported={schema === 'IFC4X3'} sourceFile={sourceFile} />
      )}
      <div className="flex items-center gap-4">
        <Label className="w-32">{t('exportDialog.schemaLabel')}</Label>
        <Select value={schema} onValueChange={(v) => setSchema(v as SchemaVersion)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['IFC2X3', 'IFC4', 'IFC4X3', 'IFC5'] as const).map((v) => (
              <SelectItem key={v} value={v}>
                {v === 'IFC5' ? t('exportDialog.schemaOption.ifc5Alpha') : v}
                {v === sourceSchema ? t('exportDialog.currentSchemaSuffix') : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Schema conversion warning */}
      {schemaConversion && (
        <Alert variant={schemaConversion === 'downgrade' ? 'destructive' : 'default'}>
          {schemaConversion === 'upgrade' ? (
            <ArrowUp className="h-4 w-4" />
          ) : (
            <ArrowDown className="h-4 w-4" />
          )}
          <AlertTitle>
            {schemaConversion === 'upgrade' ? t('exportDialog.schemaUpgradeTitle') : t('exportDialog.schemaDowngradeTitle')}
          </AlertTitle>
          <AlertDescription>
            {t('exportDialog.conversionSummary', { source: sourceSchema, target: schema })}{' '}
            {schemaConversion === 'downgrade' ? t('exportDialog.schemaDowngradeNote') : t('exportDialog.schemaUpgradeNote')}
          </AlertDescription>
        </Alert>
      )}

      {/* Output format indicator */}
      <div className="flex items-center gap-4">
        <Label className="w-32 text-muted-foreground">{t('exportDialog.outputLabel')}</Label>
        <Badge variant="secondary">{outputInfo.label}</Badge>
        <span className="text-xs text-muted-foreground">{outputInfo.ext}</span>
      </div>
    </>
  );
}
