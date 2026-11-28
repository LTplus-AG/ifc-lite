/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Retry on a failed federation slot's own model row (`lib/federation-slot-status.ts`).
 * Shown only while that slot is failed; its tooltip is the reason.
 */

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useFederationSlotFailure } from '@/lib/federation-slot-status';

export function FederationSlotRetry({ modelId, name }: { modelId: string; name: string }) {
  const { t } = useTranslation();
  const failure = useFederationSlotFailure(modelId);
  if (!failure) return null;
  return (
    // 24 px square: the WCAG 2.2 2.5.8 minimum, sized like the row's other controls.
    <Button
      variant="ghost"
      size="icon-xs"
      className="h-6 w-6 shrink-0 text-destructive"
      aria-label={t('hierarchy.node.retryModelAriaLabel', { name })}
      title={failure.reason}
      onClick={(event) => { event.stopPropagation(); failure.retry(); }}
    >
      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}
