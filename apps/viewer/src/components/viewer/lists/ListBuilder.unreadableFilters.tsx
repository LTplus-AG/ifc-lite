/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Saved filters migration could not read (#6190): a malformed member, an
 * unknown operator or source, or a rule this build does not know. They cannot
 * run, and silently dropping one would change the list, so each stays visible
 * with a Remove button until the user decides. */
import type { Dispatch, SetStateAction } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { UnreadableListCondition } from '@ifc-lite/lists';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useTranslation';

/** Never trusts the row: it is whatever the saved JSON held. */
function describe(row: unknown, malformed: string): string {
  const saved = typeof row === 'object' && row !== null ? (row as { condition?: unknown; reason?: unknown }) : {};
  const fields = typeof saved.condition === 'object' && saved.condition !== null && !Array.isArray(saved.condition)
    ? saved.condition as Record<string, unknown> : {};
  const what = [fields.kind, fields.source, fields.propertyName, fields.operator ?? fields.op]
    .filter((part): part is string => typeof part === 'string' && part.length > 0);
  const reason = typeof saved.reason === 'string' && saved.reason !== 'invalid-condition' ? ` (${saved.reason})` : '';
  return what.length > 0 ? `${malformed}: ${what.join(' ')}${reason}` : malformed;
}

export function UnreadableListFilters({ rows, onChange }: {
  rows: readonly UnreadableListCondition[];
  onChange: Dispatch<SetStateAction<UnreadableListCondition[]>>;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <div role="alert" className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
      <p className="mb-2 flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" aria-hidden />{t('lists.builder.unreadableWarning')}</p>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center justify-between gap-2">
          <span className="break-all font-mono">{describe(row, t('lists.builder.malformedCondition'))}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange((current) => current.filter((_, i) => i !== index))}>
            {t('lists.builder.removeUnreadable')}
          </Button>
        </div>
      ))}
    </div>
  );
}
