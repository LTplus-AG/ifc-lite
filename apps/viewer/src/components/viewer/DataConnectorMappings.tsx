/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Data Connector column → property mapping editor, split from `DataConnector.tsx` for its module-size budget. */

import { ArrowRight, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { PropertyValueType } from '@ifc-lite/data';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';

export interface MappingRow {
  id: string;
  sourceColumn: string;
  targetPset: string;
  targetProperty: string;
  valueType: PropertyValueType;
}

export function DataConnectorMappings({ csvColumns, mappings, canAutoDetect, onAutoDetect, onAdd, onRemove, updateMapping, onSuggest, suggesting }: {
  csvColumns: ReadonlyArray<{ name: string }>;
  mappings: readonly MappingRow[];
  canAutoDetect: boolean;
  onAutoDetect: () => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  updateMapping: (id: string, field: keyof MappingRow, value: string | number) => void;
  /** "Suggest mapping" (AI table mapping, P15); absent when no model is selected. */
  onSuggest?: () => void;
  suggesting: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{t('dataConnector.propertyMappingsLabel')}</Label>
        <div className="flex items-center gap-2">
          {onSuggest && (
            <Button variant="ghost" size="sm" onClick={onSuggest} disabled={suggesting}>
              {suggesting ? <Spinner size="xs" className="mr-1" /> : <Sparkles className="h-3 w-3 mr-1" />}
              {t(suggesting ? 'tableChanges.suggesting' : 'tableChanges.suggestButton')}
            </Button>
          )}
          {canAutoDetect && (
            <Button variant="ghost" size="sm" onClick={onAutoDetect}>
              <Wand2 className="h-3 w-3 mr-1" />
              {t('dataConnector.autoDetectButton')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onAdd}>
            <Plus className="h-3 w-3 mr-1" />
            {t('dataConnector.addMappingButton')}
          </Button>
        </div>
      </div>

      {mappings.length === 0 ? (
        <div className="text-center py-6 border rounded-lg border-dashed">
          <p className="text-sm text-muted-foreground">
            {t('dataConnector.noMappingsText')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('dataConnector.noMappingsHint')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Column headers for mapping rows */}
          <div className="grid grid-cols-[1fr_auto_1fr_1fr_auto_auto] gap-2 px-2 text-xs text-muted-foreground">
            <span>{t('dataConnector.sourceColumnHeader')}</span>
            <span />
            <span>{t('dataConnector.targetPsetHeader')}</span>
            <span>{t('dataConnector.targetPropertyHeader')}</span>
            <span>{t('dataConnector.typeHeader')}</span>
            <span />
          </div>
          {mappings.map((mapping) => (
            <div
              key={mapping.id}
              className="grid grid-cols-[1fr_auto_1fr_1fr_auto_auto] gap-2 items-center p-2 border rounded-md bg-muted/30"
            >
              <Select
                value={mapping.sourceColumn}
                onValueChange={(v) => updateMapping(mapping.id, 'sourceColumn', v)}
              >
                <SelectTrigger className="h-8">
                  <SelectValue placeholder={t('dataConnector.columnPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {csvColumns.map((col) => (
                    <SelectItem key={col.name} value={col.name}>
                      {col.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />

              <Input
                placeholder={t('dataConnector.psetNamePlaceholder')}
                aria-label={t('dataConnector.targetPsetHeader')}
                value={mapping.targetPset}
                onChange={(e) =>
                  updateMapping(mapping.id, 'targetPset', e.target.value)
                }
                className="h-8 text-xs"
              />

              <Input
                placeholder={t('dataConnector.propertyPlaceholder')}
                aria-label={t('dataConnector.targetPropertyHeader')}
                value={mapping.targetProperty}
                onChange={(e) =>
                  updateMapping(mapping.id, 'targetProperty', e.target.value)
                }
                className="h-8 text-xs"
              />

              <Select
                value={mapping.valueType.toString()}
                onValueChange={(v) =>
                  updateMapping(mapping.id, 'valueType', parseInt(v))
                }
              >
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PropertyValueType.String.toString()}>
                    {t('dataConnector.valueTypeString')}
                  </SelectItem>
                  <SelectItem value={PropertyValueType.Real.toString()}>
                    {t('dataConnector.valueTypeReal')}
                  </SelectItem>
                  <SelectItem value={PropertyValueType.Integer.toString()}>
                    {t('dataConnector.valueTypeInteger')}
                  </SelectItem>
                  <SelectItem value={PropertyValueType.Boolean.toString()}>
                    {t('dataConnector.valueTypeBoolean')}
                  </SelectItem>
                </SelectContent>
              </Select>

              <IconButton
                label={t('dataConnector.removeMappingLabel')}
                className="h-8 w-8"
                onClick={() => onRemove(mapping.id)}
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
