/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { useModelChangeReceipts } from '@/lib/actions/receipts';
import { ReceiptSummary } from './ModelChangeReview';

/** Durable receipts of reviewed change batches, newest first, in the Changes panel. */
export function ReceiptList() {
  const { t } = useTranslation();
  const receipts = useModelChangeReceipts((s) => s.entries);
  const sorted = [...receipts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <details className="border-t text-xs">
    <summary className="cursor-pointer px-3 py-2 font-medium">{t('modelChanges.receiptsTitle')} ({sorted.length})</summary>
    <div className="max-h-64 space-y-2 overflow-y-auto px-3 pb-3">
      {sorted.length === 0 ? <p className="text-muted-foreground">{t('modelChanges.receiptsEmpty')}</p>
        : sorted.map((receipt) => <div key={receipt.id} className="space-y-1">
          <p className="flex justify-between gap-2"><span className="min-w-0 truncate font-medium">{receipt.title}</span>
            <time className="shrink-0 text-muted-foreground" dateTime={receipt.createdAt}>{new Date(receipt.createdAt).toLocaleString()}</time></p>
          <ReceiptSummary receipt={receipt} />
        </div>)}
    </div>
  </details>;
}
