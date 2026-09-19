/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AlertCircle, Check } from 'lucide-react';
import type { BulkQueryResult } from '@ifc-lite/mutations';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { BulkParseResult } from './bulk-property-value';
import { appliedResultKey } from './bulk-property-editor-options';

export type BulkRuntimeFailure =
  | { kind: 'entity'; id: number; detail: string }
  | { kind: 'execute'; detail: string };

export function BulkExecutionResult({
  result,
  validationFailure,
  runtimeFailures,
}: {
  result: BulkQueryResult;
  validationFailure: Extract<BulkParseResult, { ok: false }> | null;
  runtimeFailures: readonly BulkRuntimeFailure[];
}) {
  const { t, locale } = useTranslation();
  const description = result.success
    ? t(appliedResultKey(locale, result.mutations.length, result.affectedEntityCount), {
        mutations: formatLocaleNumber(locale, result.mutations.length),
        entities: formatLocaleNumber(locale, result.affectedEntityCount),
      })
    : validationFailure
      ? t('bulkPropertyEditor.invalidValue', {
          value: validationFailure.input,
          type: t(validationFailure.typeKey),
        })
      : runtimeFailures.length > 0
        ? runtimeFailures.map((failure) => failure.kind === 'entity'
            ? t('bulkPropertyEditor.entityError', { id: failure.id, detail: failure.detail })
            : t('bulkPropertyEditor.executionFailed', { detail: failure.detail })).join(', ')
        : t('bulkPropertyEditor.unknownError');

  return (
    <Alert variant={result.success ? 'default' : 'destructive'}>
      {result.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
      <AlertTitle>{result.success ? t('bulkPropertyEditor.success') : t('bulkPropertyEditor.error')}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}
