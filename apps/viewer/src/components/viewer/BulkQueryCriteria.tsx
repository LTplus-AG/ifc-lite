/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Dispatch, SetStateAction } from 'react';
import { Search, Plus, Trash2, Building2, Layers } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Field } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FilterOperator } from '@ifc-lite/mutations';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { FILTER_OPERATORS } from './bulk-property-editor-options';

export interface PropertyFilterUI {
  id: string;
  psetName: string;
  propName: string;
  operator: FilterOperator;
  value: string;
}

interface Props {
  liveMatchCount: number;
  isComputing: boolean;
  availableTypes: { ifcType: string; label: string }[];
  selectedTypes: string[];
  setSelectedTypes: Dispatch<SetStateAction<string[]>>;
  availableStoreys: { id: number; name: string; elevation?: number }[];
  selectedStoreys: number[];
  setSelectedStoreys: Dispatch<SetStateAction<number[]>>;
  namePattern: string;
  setNamePattern: Dispatch<SetStateAction<string>>;
  filters: PropertyFilterUI[];
  addFilter: () => void;
  removeFilter: (id: string) => void;
  updateFilter: (id: string, field: keyof PropertyFilterUI, value: string) => void;
}

export function BulkQueryCriteria(props: Props) {
  const { t, locale } = useTranslation();
  const { liveMatchCount, isComputing, availableTypes, selectedTypes, setSelectedTypes,
    availableStoreys, selectedStoreys, setSelectedStoreys, namePattern, setNamePattern,
    filters, addFilter, removeFilter, updateFilter } = props;
  return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Search className="h-4 w-4" />
                {t('bulkPropertyEditor.selectionCriteria')}
              </Label>
              <Badge variant={liveMatchCount > 0 ? 'default' : 'secondary'} className="text-xs">
                {isComputing && <Spinner size="xs" className="mr-1" />}
                {t('bulkPropertyEditor.matched', {
                  count: liveMatchCount,
                  countDisplay: formatLocaleNumber(locale, liveMatchCount),
                })}
              </Badge>
            </div>

            {/* Entity type filter */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.entityTypes')}</Label>
              <div className="flex flex-wrap gap-1">
                {availableTypes.length > 0 ? (
                  availableTypes.map(({ ifcType, label }) => (
                    <Badge
                      key={ifcType}
                      variant={selectedTypes.includes(ifcType) ? 'default' : 'outline'}
                      className="cursor-pointer text-xs"
                      onClick={() => {
                        setSelectedTypes(prev =>
                          prev.includes(ifcType)
                            ? prev.filter(t => t !== ifcType)
                            : [...prev, ifcType]
                        );
                      }}
                    >
                      <Building2 className="h-3 w-3 mr-1" />
                      {label}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">{t('bulkPropertyEditor.noTypes')}</span>
                )}
              </div>
            </div>

            {/* Storey filter */}
            {availableStoreys.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.storeys')}</Label>
                <div className="flex flex-wrap gap-1">
                  {availableStoreys.map((storey) => (
                    <Badge
                      key={storey.id}
                      variant={selectedStoreys.includes(storey.id) ? 'default' : 'outline'}
                      className="cursor-pointer text-xs"
                      onClick={() => {
                        setSelectedStoreys(prev =>
                          prev.includes(storey.id)
                            ? prev.filter(s => s !== storey.id)
                            : [...prev, storey.id]
                        );
                      }}
                    >
                      <Layers className="h-3 w-3 mr-1" />
                      {storey.name}
                      {storey.elevation !== undefined && (
                        <span className="ml-1 opacity-60">
                          {t('bulkPropertyEditor.storeyElevation', {
                            sign: storey.elevation >= 0 ? '+' : '',
                            value: formatLocaleNumber(locale, storey.elevation, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
                          })}
                        </span>
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Name pattern filter */}
            <Field label={t('bulkPropertyEditor.namePattern')} labelClassName="text-xs text-muted-foreground">
              <Input
                placeholder={t('bulkPropertyEditor.namePatternPlaceholder')}
                value={namePattern}
                onChange={(e) => setNamePattern(e.target.value)}
                className="h-8 text-sm"
              />
            </Field>

            {/* Property filters */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">{t('bulkPropertyEditor.propertyFilters')}</Label>
                <Button variant="ghost" size="sm" onClick={addFilter}>
                  <Plus className="h-3 w-3 mr-1" />
                  {t('bulkPropertyEditor.addFilter')}
                </Button>
              </div>
              {filters.map((filter) => (
                <div key={filter.id} className="flex items-center gap-2 p-2 border rounded-md bg-muted/30">
                  <Field label={t('bulkPropertyEditor.psetOptional')} labelClassName="text-xs">
                    <Input
                      placeholder={t('bulkPropertyEditor.psetOptional')}
                      value={filter.psetName}
                      onChange={(e) => updateFilter(filter.id, 'psetName', e.target.value)}
                      className="h-8 text-xs w-28"
                    />
                  </Field>
                  <Field label={t('bulkPropertyEditor.propertyName')} labelClassName="text-xs">
                    <Input
                      placeholder={t('bulkPropertyEditor.propertyName')}
                      value={filter.propName}
                      onChange={(e) => updateFilter(filter.id, 'propName', e.target.value)}
                      className="h-8 text-xs flex-1"
                    />
                  </Field>
                  <Field label={t('bulkPropertyEditor.filterOperator')} labelClassName="text-xs">
                    <Select
                      value={filter.operator}
                      onValueChange={(v) => updateFilter(filter.id, 'operator', v)}
                    >
                      <SelectTrigger className="h-8 w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FILTER_OPERATORS.map((op) => (
                          <SelectItem key={op.value} value={op.value}>{t(op.labelKey)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {filter.operator !== 'IS_NULL' && filter.operator !== 'IS_NOT_NULL' && (
                    <Field label={t('bulkPropertyEditor.value')} labelClassName="text-xs">
                      <Input
                        placeholder={t('bulkPropertyEditor.value')}
                        value={filter.value}
                        onChange={(e) => updateFilter(filter.id, 'value', e.target.value)}
                        className="h-8 text-xs w-20"
                      />
                    </Field>
                  )}
                  <IconButton label={t('bulkPropertyEditor.removeFilter')} className="h-8 w-8" onClick={() => removeFilter(filter.id)}>
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
  );
}
