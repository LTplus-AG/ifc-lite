/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AddQuantityDialog`, extracted out of `PropertyEditor.tsx` (#5812) so that
 * file does not grow past its size while its fields gain real labels — every
 * field, including its `Select`s, is wrapped in `Field` (see
 * `property-editor-new-property-dialog.tsx`'s header for how `Field` labels
 * a `Select` via `FieldContext` rather than by cloning props onto it).
 */

import { useState, useCallback, useMemo } from 'react';
import { Ruler } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { getQtoDefinitionsForType, getQuantitiesForQto, getQuantityUnit, type QtoQuantityDef, type QtoDefinition } from '@/lib/ifc4-qto-definitions';
import { useTranslation } from '@/i18n';
import { hasActiveTranslation } from '@/i18n/registry';
import { EDIT_TOOL_CLS } from './PropertyEditor';

interface AddQuantityDialogProps {
  modelId: string;
  entityId: number;
  entityType: string;
  existingQtos: string[];
}

/** Schema-aware dialog for adding quantities: filters available quantity
 *  sets by IFC entity type and suggests correctly-typed IFC4 quantities. */
export function AddQuantityDialog({ modelId, entityId, entityType, existingQtos }: AddQuantityDialogProps) {
  const { t, locale } = useTranslation();
  const createPropertySet = useViewerStore((s) => s.createPropertySet);
  const setProperty = useViewerStore((s) => s.setProperty);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [open, setOpen] = useState(false);
  const [qtoName, setQtoName] = useState('');
  const [isCustomQto, setIsCustomQto] = useState(false);
  const [customQtoName, setCustomQtoName] = useState('');
  const [quantityName, setQuantityName] = useState('');
  const [customQuantityName, setCustomQuantityName] = useState('');
  const [value, setValue] = useState('');
  const [quantityType, setQuantityType] = useState<QuantityType>(QuantityType.Length);

  // Get schema-valid quantity sets for this entity type
  const validQtoDefs = useMemo(() => {
    return getQtoDefinitionsForType(entityType);
  }, [entityType]);

  // Split into: already on entity vs available to add
  const { existingStandardQtos, availableStandardQtos } = useMemo(() => {
    const existing: QtoDefinition[] = [];
    const available: QtoDefinition[] = [];
    for (const def of validQtoDefs) {
      if (existingQtos.includes(def.name)) {
        existing.push(def);
      } else {
        available.push(def);
      }
    }
    return { existingStandardQtos: existing, availableStandardQtos: available };
  }, [validQtoDefs, existingQtos]);

  // Get quantity suggestions for selected qto set
  const quantitySuggestions = useMemo((): QtoQuantityDef[] => {
    if (!qtoName || isCustomQto) return [];
    return getQuantitiesForQto(qtoName);
  }, [qtoName, isCustomQto]);

  const effectiveQtoName = isCustomQto ? customQtoName : qtoName;
  const effectiveQuantityName = quantityName || customQuantityName;

  // Auto-update type when selecting a standard quantity
  const handleQuantitySelect = useCallback((name: string) => {
    setQuantityName(name);
    setCustomQuantityName('');
    const qtyDef = quantitySuggestions.find(q => q.name === name);
    if (qtyDef) {
      setQuantityType(qtyDef.type);
    }
  }, [quantitySuggestions]);

  const handleSubmit = useCallback(() => {
    if (!effectiveQtoName || !effectiveQuantityName) return;

    const parsedValue = parseFloat(value);
    if (Number.isNaN(parsedValue)) {
      return toast.error(t('propertyEditor.quantity.invalid', { value }));
    }
    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    // Store quantity as a property set (mutation system uses property sets)
    const qtoExists = existingQtos.includes(effectiveQtoName);

    if (!qtoExists) {
      createPropertySet(normalizedModelId, entityId, effectiveQtoName, [
        { name: effectiveQuantityName, value: parsedValue, type: PropertyValueType.Real },
      ]);
    } else {
      setProperty(normalizedModelId, entityId, effectiveQtoName, effectiveQuantityName, parsedValue, PropertyValueType.Real);
    }

    bumpMutationVersion();

    // Reset form
    setQtoName('');
    setCustomQtoName('');
    setQuantityName('');
    setCustomQuantityName('');
    setValue('');
    setQuantityType(QuantityType.Length);
    setIsCustomQto(false);
    setOpen(false);
  }, [modelId, entityId, effectiveQtoName, effectiveQuantityName, value, existingQtos, setProperty, createPropertySet, bumpMutationVersion, t]);

  const resetForm = useCallback(() => {
    setQtoName('');
    setCustomQtoName('');
    setQuantityName('');
    setCustomQuantityName('');
    setValue('');
    setQuantityType(QuantityType.Length);
    setIsCustomQto(false);
  }, []);

  const setToggle = (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-2xs"
      onClick={() => { setIsCustomQto(!isCustomQto); setQtoName(''); setCustomQtoName(''); setQuantityName(''); setCustomQuantityName(''); }}
    >
      {isCustomQto ? t('propertyEditor.shared.useStandard') : t('propertyEditor.shared.customName')}
    </Button>
  );

  const valueLabel = (
    <>
      {t('propertyEditor.shared.value')}
      {quantityName && (
        <span className="ml-2 text-xs text-zinc-400 font-normal">({getQuantityUnit(quantityType)})</span>
      )}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
      <DialogTrigger asChild>
        <IconButton label={t('propertyEditor.quantity.trigger')} className={EDIT_TOOL_CLS}>
          <Ruler className="h-3.5 w-3.5" />
        </IconButton>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ruler className="h-4 w-4" />
            {t('propertyEditor.quantity.title')}
          </DialogTitle>
          <DialogDescription>
            {t('propertyEditor.quantity.description', { entityType })}
            {validQtoDefs.length > 0 && (
              <span className="block mt-1 text-emerald-600 dark:text-emerald-400">
                {t('propertyEditor.quantity.available', { count: validQtoDefs.length })}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Quantity Set Selection */}
          <div className="space-y-2">
            {isCustomQto ? (
              <Field label={t('propertyEditor.quantity.setLabel')} labelAction={setToggle}>
                <Input
                  value={customQtoName}
                  onChange={(e) => setCustomQtoName(e.target.value)}
                  placeholder={t('propertyEditor.quantity.customSetPlaceholder')}
                  className="font-mono text-sm"
                />
              </Field>
            ) : (
              <Field label={t('propertyEditor.quantity.setLabel')} labelAction={setToggle}>
                <Select value={qtoName} onValueChange={(v) => { setQtoName(v); setQuantityName(''); setCustomQuantityName(''); setValue(''); }}>
                  <SelectTrigger className="font-mono text-sm">
                    <SelectValue placeholder={t('propertyEditor.quantity.selectSet')} />
                  </SelectTrigger>
                  <SelectContent>
                    {existingStandardQtos.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-zinc-400">
                          {t('propertyEditor.shared.onElement')}
                        </div>
                        {existingStandardQtos.map((def) => (
                          <SelectItem key={def.name} value={def.name}>
                            <div className="flex items-center gap-2">
                              <span>{def.name}</span>
                              <Badge variant="secondary" className="h-4 px-1 text-2xs">{t('propertyEditor.shared.existing')}</Badge>
                            </div>
                          </SelectItem>
                        ))}
                      </>
                    )}
                    {existingQtos.filter(q => !existingStandardQtos.some(d => d.name === q)).length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-zinc-400">
                          {t('propertyEditor.shared.existingCustom')}
                        </div>
                        {existingQtos.filter(q => !existingStandardQtos.some(d => d.name === q)).map((name) => (
                          <SelectItem key={name} value={name}>
                            <span>{name}</span>
                          </SelectItem>
                        ))}
                      </>
                    )}
                    {availableStandardQtos.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                          {t('propertyEditor.quantity.standardGroup', { entityType })}
                        </div>
                        {availableStandardQtos.map((def) => (
                          <SelectItem key={def.name} value={def.name}>
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{def.name}</span>
                                <Badge variant="outline" className="h-4 px-1 text-2xs border-emerald-300 text-emerald-600">{t('propertyEditor.shared.new')}</Badge>
                              </div>
                              <span className="text-2xs text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.quantity.standardSetDescription') ? def.description : t('propertyEditor.quantity.standardSetDescription', { name: def.name })}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>

          {/* Quantity Selection */}
          <div className="space-y-2">
            {quantitySuggestions.length > 0 ? (
              <div className="space-y-2">
                <Field label={t('propertyEditor.quantity.label')}>
                  <Select value={quantityName} onValueChange={handleQuantitySelect}>
                    <SelectTrigger className="font-mono text-sm">
                      <SelectValue placeholder={t('propertyEditor.quantity.select')} />
                    </SelectTrigger>
                    <SelectContent>
                      {quantitySuggestions.map((qty) => (
                        <SelectItem key={qty.name} value={qty.name}>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{qty.name}</span>
                              <Badge variant="secondary" className="h-4 px-1 text-2xs">{qty.unit}</Badge>
                            </div>
                            <span className="text-2xs text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.quantity.standardQuantityDescription') ? qty.description : t('propertyEditor.quantity.standardQuantityDescription', { name: qty.name })}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {!quantityName && (
                  <Field label={t('propertyEditor.quantity.label')} labelClassName="sr-only">
                    <Input
                      value={customQuantityName}
                      onChange={(e) => setCustomQuantityName(e.target.value)}
                      placeholder={t('propertyEditor.quantity.customPlaceholder')}
                      className="font-mono text-sm"
                    />
                  </Field>
                )}
              </div>
            ) : (
              <Field label={t('propertyEditor.quantity.label')}>
                <Input
                  value={customQuantityName}
                  onChange={(e) => setCustomQuantityName(e.target.value)}
                  placeholder={t('propertyEditor.quantity.examplePlaceholder')}
                  className="font-mono text-sm"
                />
              </Field>
            )}
          </div>

          {/* Value input */}
          <Field label={valueLabel}>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('propertyEditor.quantity.numericPlaceholder')}
              type="number"
              step="any"
              className="font-mono text-sm"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>
            {t('propertyEditor.shared.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!effectiveQtoName || !effectiveQuantityName}>
            {t('propertyEditor.quantity.title')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
