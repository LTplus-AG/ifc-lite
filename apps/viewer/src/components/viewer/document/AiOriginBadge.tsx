/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { aiBlockOrigin } from '@/lib/document/ai-report-types';
import type { TextBlock } from '@/lib/document/types';

/** Marks generator-written text in the block list (#6918): what the AI wrote, and what a person changed since. */
export function AiOriginBadge({ block }: { block: TextBlock }) {
  const { t } = useTranslation();
  const origin = aiBlockOrigin(block);
  if (origin === 'human') return null;
  return <span data-ai-origin={origin} className="rounded border border-border px-1 text-2xs text-muted-foreground">
    {t(origin === 'ai-generated' ? 'aiReports.originGenerated' : 'aiReports.originEdited')}</span>;
}
