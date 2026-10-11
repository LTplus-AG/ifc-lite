/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { Save, Sparkles } from 'lucide-react';
import type { CapturedEntityScope } from '@ifc-lite/rules';
import type { Lens, AutoColorSpec, DiscoveredLensData } from '@/store/slices/lensSlice';
import { AUTO_COLOR_SOURCES, ENTITY_ATTRIBUTE_NAMES } from '@/store/slices/lensSlice';
import { cn } from '@/lib/utils';
import { SearchableSelect } from './SearchableSelect';
import { buildAutoColorLensToSave } from './lens-editor-utils';
import { TYPE_LABEL_KEYS } from './lens-editor-labels';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { CapturedScopeControl } from './result/CapturedScopeControl';

export function AutoColorEditor({
  initial,
  onSave,
  onCancel,
  discovered,
  onRequestDiscovery,
}: {
  initial: { id?: string; name: string; autoColor: AutoColorSpec; capturedScope?: CapturedEntityScope };
  onSave: (lens: Lens) => void;
  onCancel: () => void;
  discovered: DiscoveredLensData | null;
  onRequestDiscovery: (categories: { properties?: boolean; quantities?: boolean; classifications?: boolean; materials?: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [capturedScope, setCapturedScope] = useState(initial.capturedScope);
  const [source, setSource] = useState<AutoColorSpec['source']>(initial.autoColor.source);
  const [psetName, setPsetName] = useState(initial.autoColor.psetName ?? '');
  const [propertyName, setPropertyName] = useState(initial.autoColor.propertyName ?? '');
  // Opt-in "unclassified bucket" toggle (#unclassified-bucket) - meaningless
  // outside `source: 'classification'`, so it's only rendered there. Not
  // reset on source change like psetName/propertyName: if the user flips
  // away from classification and back, restoring their choice is friendlier
  // than silently discarding it, and the flag is dropped from the saved
  // spec entirely when the source isn't classification (see handleSave).
  const [includeUnclassified, setIncludeUnclassified] = useState(initial.autoColor.includeUnclassified ?? false);

  const needsPset = source === 'property' || source === 'quantity' || source === 'classification';
  const needsPropertyName = source === 'attribute' || source === 'property' || source === 'quantity';

  // Trigger lazy discovery when source changes to a category that needs it
  useEffect(() => {
    if (!discovered) return;
    if (source === 'property' && !discovered.propertySets) {
      onRequestDiscovery({ properties: true });
    } else if (source === 'quantity' && !discovered.quantitySets) {
      onRequestDiscovery({ quantities: true });
    } else if (source === 'material' && !discovered.materials) {
      onRequestDiscovery({ materials: true });
    } else if (source === 'classification' && !discovered.classificationSystems) {
      onRequestDiscovery({ classifications: true });
    }
  }, [source, discovered, onRequestDiscovery]);

  // Dynamic options from discovered data
  const psetOptions = useMemo(() => {
    if (!discovered) return [];
    if (source === 'quantity') return discovered.quantitySets ? Array.from(discovered.quantitySets.keys()).sort() : [];
    if (source === 'classification') return discovered.classificationSystems ?? [];
    return discovered.propertySets ? Array.from(discovered.propertySets.keys()).sort() : [];
  }, [discovered, source]);

  const propertyOptions = useMemo(() => {
    if (!discovered) return [];
    if (source === 'property') return discovered.propertySets?.get(psetName) ?? [];
    if (source === 'quantity') return discovered.quantitySets?.get(psetName) ?? [];
    return [];
  }, [discovered, source, psetName]);

  const handleSave = () => {
    if (!name.trim()) return;
    if (needsPset && !psetName.trim()) return;
    if (needsPropertyName && !propertyName.trim()) return;

    const autoColor: AutoColorSpec = { source };
    if (needsPset) autoColor.psetName = psetName.trim();
    if (needsPropertyName) autoColor.propertyName = propertyName.trim();
    // Only emitted when true, on a classification source: unset/false must
    // reproduce the pre-existing ghosting behaviour exactly (see
    // AutoColorSpec.includeUnclassified in @ifc-lite/lens), and the flag is
    // meaningless on any other source.
    if (source === 'classification' && includeUnclassified) autoColor.includeUnclassified = true;

    onSave({ ...buildAutoColorLensToSave(
      initial,
      { name: name.trim(), autoColor },
      () => `lens-auto-${Date.now()}`,
    ), capturedScope });
  };

  const canSave = name.trim().length > 0
    && (!needsPset || psetName.trim().length > 0)
    && (!needsPropertyName || propertyName.trim().length > 0);

  const selectClass = 'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm';

  return (
    <div className="border-2 border-primary bg-white dark:bg-zinc-900 rounded-sm">
      <div className="px-3 pt-3 pb-2">
        <input
          type="text" value={name} aria-label={t('lensPanel.autoColor.namePlaceholder')}
          onChange={(e) => setName(e.target.value)} placeholder={t('lensPanel.autoColor.namePlaceholder')}
          className="w-full px-2 py-1.5 text-xs font-bold uppercase tracking-wider bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm placeholder:normal-case placeholder:font-normal placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          // The newly opened color-rule editor places keyboard focus on its name.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
      </div>

      <CapturedScopeControl scope={capturedScope} onChange={setCapturedScope} />

      <div className="border-t border-zinc-200 dark:border-zinc-700 px-3 py-2 space-y-2 bg-zinc-50/50 dark:bg-zinc-800/50">
        <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
          <Sparkles className="h-3 w-3" />
          <span>{t('lensPanel.autoColor.byDistinctValues')}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-2xs uppercase tracking-wider text-zinc-500 w-[50px]">{t('lensPanel.autoColor.sourceLabel')}</label>
          <select
            value={source} aria-label={t('lensPanel.autoColor.sourceLabel')}
            onChange={(e) => {
              const s = e.target.value as AutoColorSpec['source'];
              setSource(s);
              setPsetName('');
              setPropertyName('');
              if (!name || name.startsWith('Color by ')) {
                setName(`Color by ${t(TYPE_LABEL_KEYS[s])}`);
              }
            }}
            className={cn(selectClass, 'flex-1')}
          >
            {AUTO_COLOR_SOURCES.map(s => (
              <option key={s} value={s}>{t(TYPE_LABEL_KEYS[s])}</option>
            ))}
          </select>
        </div>

        {needsPset && (
          <div className="flex items-center gap-1.5">
            <label className="text-2xs uppercase tracking-wider text-zinc-500 w-[50px]">
              {source === 'property' ? t('lensPanel.autoColor.psetLabel') : source === 'classification' ? t('lensPanel.autoColor.systemLabel') : t('lensPanel.autoColor.qsetLabel')}
            </label>
            <SearchableSelect
              value={psetName}
              options={psetOptions}
              onChange={(v) => { setPsetName(v); setPropertyName(''); }}
              placeholder={source === 'property' ? t('lensPanel.autoColor.selectPropertySetPlaceholder') : source === 'classification' ? t('lensPanel.autoColor.selectSystemPlaceholder') : t('lensPanel.autoColor.selectQuantitySetPlaceholder')}
              className="flex-1"
            />
          </div>
        )}

        {needsPropertyName && (
          <div className="flex items-center gap-1.5">
            <label className="text-2xs uppercase tracking-wider text-zinc-500 w-[50px]">{t('lensPanel.autoColor.nameLabel')}</label>
            {source === 'attribute' ? (
              <select
                value={propertyName} aria-label={t('lensPanel.autoColor.nameLabel')}
                onChange={(e) => setPropertyName(e.target.value)}
                className={cn(selectClass, 'flex-1')}
              >
                <option value="">{t('lensPanel.autoColor.selectPlaceholderOption')}</option>
                {ENTITY_ATTRIBUTE_NAMES.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            ) : (
              <SearchableSelect
                value={propertyName}
                options={propertyOptions}
                onChange={setPropertyName}
                placeholder={source === 'property' ? t('lensPanel.autoColor.selectPropertyPlaceholder') : t('lensPanel.autoColor.selectQuantityPlaceholder')}
                className="flex-1"
              />
            )}
          </div>
        )}

        {source === 'classification' && (
          <label className="flex items-center justify-between gap-2 cursor-pointer pt-0.5">
            <span className="text-2xs uppercase tracking-wider text-zinc-500">{t('lensPanel.autoColor.showUnclassified')}</span>
            <input
              type="checkbox"
              checked={includeUnclassified}
              onChange={(e) => setIncludeUnclassified(e.target.checked)}
              className="accent-primary"
            />
          </label>
        )}
      </div>

      <div className="flex gap-1.5 p-2 border-t border-zinc-200 dark:border-zinc-700">
        <Button
          variant="default"
          size="sm"
          className="flex-1 h-7 text-2xs uppercase tracking-wider rounded-sm"
          onClick={handleSave}
          disabled={!canSave}
        >
          <Save className="h-3 w-3 mr-1" />
          {t('lensPanel.editor.save')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-2xs uppercase tracking-wider rounded-sm"
          onClick={onCancel}
        >
          {t('lensPanel.editor.cancel')}
        </Button>
      </div>
    </div>
  );
}
