import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';

export function MaterialColourField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const { t } = useTranslation();
  const label = t('propertyEditor.material.colour');
  return <div className="flex items-center gap-2">
    <label htmlFor={id} className="text-xs">{label}</label>
    <input aria-label={label} type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#808080'} onChange={e => onChange(e.target.value)} />
    <Input id={id} aria-label={t('propertyEditor.material.colourHex')} value={value} onChange={e => onChange(e.target.value)} pattern="#[0-9a-fA-F]{6}" className="h-7 font-mono text-xs" />
  </div>;
}
