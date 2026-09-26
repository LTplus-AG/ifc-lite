/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One Player form widget (#5167 Phase 4.1): the shape depends on the
 * input's declared `InputKind` and, for `scalar`, the underlying node
 * param's `ParamKind` — same lookup `FlowInspector`'s `ParamField` does
 * for the canvas, but simpler (no code-editor dialog, no lacing).
 */

import type { EntityData } from '@ifc-lite/sdk';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslatableMessage } from '@/i18n/types';
import type { PlayerField } from '@/lib/flow/player-fields';

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs';

function ScalarWidget({ field, value, onChange }: { field: PlayerField; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.paramKind) {
    case 'boolean':
      return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="accent-[#7aa2f7]" />;
    case 'number':
      return <input type="number" className={input} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
    case 'enum':
      return (
        <select className={input} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>…</option>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'json':
      return <textarea className={`${input} font-mono`} rows={2} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
    case 'code':
      return <textarea className={`${input} font-mono`} rows={3} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input className={input} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

async function readFileAsText(file: File): Promise<string> {
  return file.text();
}

export interface FlowPlayerFieldProps {
  readonly field: PlayerField;
  readonly value: unknown;
  readonly error: TranslatableMessage | undefined;
  readonly storeys: readonly EntityData[];
  readonly onChange: (v: unknown) => void;
}

export function FlowPlayerField({ field, value, error, storeys, onChange }: FlowPlayerFieldProps) {
  const { t } = useTranslation();
  const kind = field.input.kind;

  let widget: React.ReactNode;
  if (kind === 'scalar') {
    widget = <ScalarWidget field={field} value={value} onChange={onChange} />;
  } else if (kind === 'enum') {
    widget = (
      <select className={input} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>…</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (kind === 'entitySet') {
    widget = (
      <textarea
        className={`${input} font-mono`}
        rows={2}
        placeholder={t('flowPanel.player.entitySetPlaceholder')}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (kind === 'storey') {
    widget = (
      <select className={input} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>…</option>
        {storeys.map((s) => <option key={s.globalId} value={s.globalId}>{s.name || s.globalId}</option>)}
      </select>
    );
  } else if (kind === 'file') {
    widget = (
      <input
        type="file"
        className={input}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) { onChange(undefined); return; }
          void readFileAsText(file).then(onChange);
        }}
      />
    );
  } else if (kind === 'table') {
    widget = (
      <textarea
        className={`${input} font-mono`}
        rows={3}
        placeholder={t('flowPanel.player.tablePlaceholder')}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    widget = <span className="text-red-400">{t('flowPanel.player.error.unknownKind', { kind: String(kind as string) })}</span>;
  }

  return (
    <label className="block">
      <span className="text-muted-foreground">{field.input.label}</span>
      {widget}
      {error && <div className="text-2xs text-red-400">{t(error.labelKey, error.params)}</div>}
    </label>
  );
}
