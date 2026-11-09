/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material display component for IFC element materials.
 * Handles all IFC material types: direct, layer sets, profile sets,
 * constituent sets, and material lists.
 */

import { CollapsibleContent } from '@/components/ui/collapsible';
import { Layers } from 'lucide-react';
import type { MaterialInfo } from '@ifc-lite/parser';
import { useTranslation, type TranslationKey } from '@/i18n';
import { EXPRESS_CATEGORY_ATTRIBUTE, EXPRESS_IS_VENTILATED_ATTRIBUTE, EXPRESS_NAME_ATTRIBUTE } from './express-labels';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { PersistentCollapsible } from './PersistentCollapsible';
import { associationDisclosureId } from './associationDisclosureId';
import { INSPECTOR_ROWS, INSPECTOR_SECTION, InspectorRow, InspectorSectionTrigger } from './inspector-ui';

export const TYPE_LABEL_KEYS: Record<MaterialInfo['type'], TranslationKey> = {
  Material: 'properties.material.typeLabel.material',
  MaterialLayerSet: 'properties.material.typeLabel.layerSet',
  MaterialProfileSet: 'properties.material.typeLabel.profileSet',
  MaterialConstituentSet: 'properties.material.typeLabel.constituentSet',
  MaterialList: 'properties.material.typeLabel.materialList',
};

export function MaterialCard({ material, sectionId }: { material: MaterialInfo; sectionId?: string }) {
  const { t, locale } = useTranslation();
  const typeLabelKey = TYPE_LABEL_KEYS[material.type];
  const typeLabel = typeLabelKey ? t(typeLabelKey) : material.type;
  const displayName = material.name || typeLabel;

  return (
    <PersistentCollapsible id={sectionId ?? associationDisclosureId('material', material, [material], 0)} className={INSPECTOR_SECTION}>
      <InspectorSectionTrigger
        icon={<Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        title={displayName}
        trailing={<span className="shrink-0 pr-1 text-2xs text-muted-foreground">{typeLabel}</span>}
      />
      <CollapsibleContent>
        <div className={INSPECTOR_ROWS}>
          {/* Direct material */}
          {material.type === 'Material' && (
            <>
              {material.name && (
                <MaterialRow label="Name" value={material.name} />
              )}
              {material.description && (
                <MaterialRow label="Description" value={material.description} />
              )}
            </>
          )}

          {/* Layer Set */}
          {material.type === 'MaterialLayerSet' && material.layers && (
            <>
              {material.name && <MaterialRow label={t('properties.material.setName')} value={material.name} />}
              {material.layers.map((layer, i) => (
                <div key={i} className="px-3 py-1 text-xs">
                  <div className="flex h-6 items-center gap-2">
                    <span className="font-medium text-foreground">
                      {t('properties.material.layerN', { n: i + 1 })}
                    </span>
                    {layer.thickness !== undefined && (
                      <span className="text-2xs font-mono tabular-nums text-muted-foreground">
                        {formatThickness(layer.thickness, locale)}
                      </span>
                    )}
                  </div>
                  <div className="inspector-kv inspector-kv-sub gap-x-2 gap-y-0.5">
                    {layer.materialName && (
                      <>
                        <span className="text-muted-foreground">{t('properties.material.materialLabel')}</span>
                        <span className="text-foreground break-words">{layer.materialName}</span>
                      </>
                    )}
                    {layer.name && (
                      <>
                        <span className="text-muted-foreground">{EXPRESS_NAME_ATTRIBUTE}</span>
                        <span className="text-foreground break-words">{layer.name}</span>
                      </>
                    )}
                    {layer.category && (
                      <>
                        <span className="text-muted-foreground">{EXPRESS_CATEGORY_ATTRIBUTE}</span>
                        <span className="text-foreground break-words">{layer.category}</span>
                      </>
                    )}
                    {layer.isVentilated && (
                      <>
                        <span className="text-muted-foreground">{EXPRESS_IS_VENTILATED_ATTRIBUTE}</span>
                        <span className="text-foreground">{t('properties.material.yes')}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Profile Set */}
          {material.type === 'MaterialProfileSet' && material.profiles && (
            <>
              {material.name && <MaterialRow label={t('properties.material.setName')} value={material.name} />}
              {material.profiles.map((profile, i) => (
                <div key={i} className="px-3 py-1 text-xs">
                  <div className="flex h-6 items-center gap-2">
                    <span className="font-medium text-foreground">
                      {t('properties.material.profileN', { n: i + 1 })}
                    </span>
                  </div>
                  <div className="inspector-kv inspector-kv-sub gap-x-2 gap-y-0.5">
                    {profile.materialName && (
                      <>
                        <span className="text-muted-foreground">{t('properties.material.materialLabel')}</span>
                        <span className="text-foreground break-words">{profile.materialName}</span>
                      </>
                    )}
                    {profile.name && (
                      <>
                        <span className="text-muted-foreground">{EXPRESS_NAME_ATTRIBUTE}</span>
                        <span className="text-foreground break-words">{profile.name}</span>
                      </>
                    )}
                    {profile.category && (
                      <>
                        <span className="text-muted-foreground">{EXPRESS_CATEGORY_ATTRIBUTE}</span>
                        <span className="text-foreground break-words">{profile.category}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Constituent Set */}
          {material.type === 'MaterialConstituentSet' && material.constituents && (
            <>
              {material.name && <MaterialRow label={t('properties.material.setName')} value={material.name} />}
              {material.constituents.map((constituent, i) => (
                <div key={i} className="px-3 py-1 text-xs">
                  <div className="flex h-6 items-center gap-2">
                    <span className="font-medium text-foreground">
                      {constituent.name || t('properties.material.constituentN', { n: i + 1 })}
                    </span>
                    {constituent.fraction !== undefined && (
                      <span className="text-2xs font-mono tabular-nums text-muted-foreground">
                        {formatLocaleNumber(locale, constituent.fraction * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                      </span>
                    )}
                  </div>
                  <div className="inspector-kv inspector-kv-sub gap-x-2 gap-y-0.5">
                    {constituent.materialName && (
                      <>
                        <span className="text-muted-foreground">{t('properties.material.materialLabel')}</span>
                        <span className="text-foreground break-words">{constituent.materialName}</span>
                      </>
                    )}
                    {constituent.category && (
                      <>
                        <span className="text-muted-foreground">{EXPRESS_CATEGORY_ATTRIBUTE}</span>
                        <span className="text-foreground break-words">{constituent.category}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* Material List */}
          {material.type === 'MaterialList' && material.materials && (
            <>
              {material.materials.map((m, i) => (
                <MaterialRow key={i} label={t('properties.material.materialN', { n: i + 1 })} value={m.name} />
              ))}
            </>
          )}
        </div>
      </CollapsibleContent>
    </PersistentCollapsible>
  );
}

function MaterialRow({ label, value }: { label: string; value: string }) {
  return <InspectorRow label={label} value={value} />;
}

export function formatThickness(thickness: number, locale: string): string {
  if (thickness <= 0) return `${formatLocaleNumber(locale, thickness, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`;
  if (thickness >= 1) {
    return `${formatLocaleNumber(locale, thickness, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`;
  }
  // Show in mm for sub-meter thicknesses
  const mm = thickness * 1000;
  return `${formatLocaleNumber(locale, mm, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mm`;
}
