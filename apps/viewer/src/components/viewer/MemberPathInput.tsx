/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The complex-property member a `property` rule or subject reads
 * (`memberPath` in `@ifc-lite/rules`, #5475), for the rule chips and the
 * validation subject picker. One level per `/`-separated name
 * (`Frame / Width`); empty clears it. A member name that itself contains a
 * `/` can only be set in the rule-set JSON.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';

function memberPathFromText(text: string): string[] | undefined {
  const names = text.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
  return names.length > 0 ? names : undefined;
}

export function MemberPathInput({
  value,
  onChange,
}: {
  value: readonly string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const shown = (value ?? []).join(' / ');
  const [text, setText] = useState(shown);
  // An outside change (undo, a loaded file) re-seeds the text without remounting, so focus stays.
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const next = memberPathFromText(text);
    if ((next ?? []).join('\u0000') !== (value ?? []).join('\u0000')) onChange(next);
  };
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      placeholder={t('searchModal.filterEditors.memberPath.placeholder')}
      aria-label={t('searchModal.filterEditors.memberPath.ariaLabel')}
      title={t('searchModal.filterEditors.memberPath.title')}
      spellCheck={false}
      className="h-7 w-24 rounded border border-zinc-300 bg-transparent px-1 font-mono text-2xs dark:border-zinc-700"
    />
  );
}
