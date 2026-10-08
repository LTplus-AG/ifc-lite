/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { automationInput, automationButton } from './editor-styles';
import { useState } from 'react';
import { useTranslation } from '@/i18n';
export function TagBindingsEditor({ referenced, value, onChange }: {
  referenced: readonly string[]; value: Readonly<Record<string, string>>; onChange: (bindings: Readonly<Record<string, string>>) => void;
}) {
  const { t } = useTranslation();
  const [newId, setNewId] = useState('');
  const ids = [...new Set([...referenced, ...Object.keys(value)])];
  return <div>
    {ids.map((id) => <label className="block" key={id}>{t('automationEditor.tagBinding', { id })}
      <input className={automationInput} aria-label={t('automationEditor.tagBinding', { id })} value={value[id] ?? ''}
        onChange={(event) => onChange({ ...value, [id]: event.target.value })} />
    </label>)}
    <input className={automationInput} aria-label={t('automationEditor.bindingId')} value={newId} onChange={(event) => setNewId(event.target.value)} />
    <button className={automationButton} type="button" disabled={!newId.trim()} onClick={() => { onChange({ ...value, [newId.trim()]: '' }); setNewId(''); }}>{t('automationEditor.addBinding')}</button>
  </div>;
}
