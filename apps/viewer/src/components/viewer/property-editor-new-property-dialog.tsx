/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `NewPropertyDialog`, extracted out of `PropertyEditor.tsx` (#5812) so that
 * file does not grow past its size while its fields gain real labels.
 *
 * Labelling (#5812): the "Property Set" and "Property" fields swap between
 * an `Input` (custom name) and a `Select` (standard picker), both wrapped
 * in the SAME `<Field>` either way — `Field` labels the `Input` branch by
 * cloning its id directly onto it; for the `Select` branch, `SelectTrigger`
 * (see `ui/select.tsx`) reads the label/id/describedby back out of
 * `FieldContext`, since a Radix `Select` is headless and `Field` cloning
 * props onto it directly would land on a component that never uses them.
 * `Field`'s `labelAction` slot carries the shared "use custom/standard
 * name" toggle button beside the one label used by both branches.
 */

import { useState, useCallback, useMemo } from 'react';
import { BookOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { PropertyValueType } from '@ifc-lite/data';
import { getPsetDefinitionsForType, getPropertiesForPset, type PsetPropertyDef, type PsetDefinition } from '@/lib/ifc4-pset-definitions';
import { useTranslation } from '@/i18n';
import { hasActiveTranslation } from '@/i18n/registry';
import { addToPropertySet, isInheritedOnly, type InheritedSets } from '@/lib/properties/add-to-property-set';
import { EDIT_TOOL_CLS, getTypeNameKey, parseValue, PARSE_INVALID } from './PropertyEditor';

interface NewPropertyDialogProps {
  modelId: string;
  entityId: number;
  entityType: string;
  existingPsets: string[];
  schemaVersion?: string;
  /** Sets the element only inherits from its type (#5966). */
  inheritedFrom?: InheritedSets | null;
}

/** Schema-aware dialog for adding new properties: filters available property
 *  sets by IFC entity type and suggests correctly-typed IFC4 properties. */
export function NewPropertyDialog({ modelId, entityId, entityType, existingPsets, schemaVersion, inheritedFrom }: NewPropertyDialogProps) {
  const { t, locale } = useTranslation();
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [open, setOpen] = useState(false);
  const [psetName, setPsetName] = useState('');
  const [isCustomPset, setIsCustomPset] = useState(false);
  const [customPsetName, setCustomPsetName] = useState('');
  const [propName, setPropName] = useState('');
  const [customPropName, setCustomPropName] = useState('');
  const [value, setValue] = useState('');
  const [valueType, setValueType] = useState<PropertyValueType>(PropertyValueType.String);

  // Get schema-valid property sets for this entity type
  const validPsetDefs = useMemo(() => {
    return getPsetDefinitionsForType(entityType, schemaVersion);
  }, [entityType, schemaVersion]);

  // Split into: already on entity vs available to add
  const { existingStandardPsets, availableStandardPsets } = useMemo(() => {
    const existing: PsetDefinition[] = [];
    const available: PsetDefinition[] = [];
    for (const def of validPsetDefs) {
      if (existingPsets.includes(def.name)) {
        existing.push(def);
      } else {
        available.push(def);
      }
    }
    return { existingStandardPsets: existing, availableStandardPsets: available };
  }, [validPsetDefs, existingPsets]);

  // Get property suggestions for selected pset
  const propertySuggestions = useMemo((): PsetPropertyDef[] => {
    if (!psetName || isCustomPset) return [];
    return getPropertiesForPset(psetName);
  }, [psetName, isCustomPset]);

  // Determine effective property name and type
  const effectivePsetName = isCustomPset ? customPsetName : psetName;
  const effectivePropName = propName || customPropName;

  // Auto-update type when selecting a standard property
  const handlePropertySelect = useCallback((name: string) => {
    setPropName(name);
    setCustomPropName('');
    // Auto-set type from schema
    const propDef = propertySuggestions.find(p => p.name === name);
    if (propDef) {
      setValueType(propDef.type);
      // Set sensible defaults for boolean properties
      if (propDef.type === PropertyValueType.Boolean) {
        setValue('false');
      }
    }
  }, [propertySuggestions]);

  const handleSubmit = useCallback(() => {
    if (!effectivePsetName || !effectivePropName) return;

    const parsedValue = parseValue(value, valueType);
    if (parsedValue === PARSE_INVALID) {
      return toast.error(t('propertyEditor.property.invalid', { value, type: t(getTypeNameKey(valueType)) }));
    }
    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    const added = addToPropertySet(useViewerStore.getState(), { modelId: normalizedModelId, entityId, existingPsets, inheritedFrom }, effectivePsetName, [
      { name: effectivePropName, value: parsedValue, type: valueType },
    ]);
    if (!added.ok) return toast.error(t('propertyEditor.property.inheritedNotCopyable', { psetName: effectivePsetName, typeName: inheritedFrom?.typeName ?? '', names: added.uncopyable.join(', ') }));

    bumpMutationVersion();

    // Reset form
    setPsetName('');
    setCustomPsetName('');
    setPropName('');
    setCustomPropName('');
    setValue('');
    setValueType(PropertyValueType.String);
    setIsCustomPset(false);
    setOpen(false);
  }, [modelId, entityId, effectivePsetName, effectivePropName, value, valueType, existingPsets, inheritedFrom, bumpMutationVersion, t]);

  const resetForm = useCallback(() => {
    setPsetName('');
    setCustomPsetName('');
    setPropName('');
    setCustomPropName('');
    setValue('');
    setValueType(PropertyValueType.String);
    setIsCustomPset(false);
  }, []);

  const setToggle = (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-2xs"
      onClick={() => { setIsCustomPset(!isCustomPset); setPsetName(''); setCustomPsetName(''); setPropName(''); setCustomPropName(''); }}
    >
      {isCustomPset ? t('propertyEditor.shared.useStandard') : t('propertyEditor.shared.customName')}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
      <DialogTrigger asChild>
        <IconButton label={t('propertyEditor.property.trigger')} className={EDIT_TOOL_CLS}>
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            {t('propertyEditor.property.title')}
          </DialogTitle>
          <DialogDescription>
            {t('propertyEditor.property.description', { entityType })}
            {validPsetDefs.length > 0 && (
              <span className="block mt-1 text-emerald-600 dark:text-emerald-400">
                {t('propertyEditor.property.available', {
                  schema: schemaVersion || 'IFC4',
                  count: validPsetDefs.length,
                })}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Property Set Selection */}
          <div className="space-y-2">
            {isCustomPset ? (
              <Field label={t('propertyEditor.property.setLabel')} labelAction={setToggle}>
                <Input
                  value={customPsetName}
                  onChange={(e) => setCustomPsetName(e.target.value)}
                  placeholder={t('propertyEditor.property.customSetPlaceholder')}
                  className="font-mono text-sm"
                />
              </Field>
            ) : (
              <Field label={t('propertyEditor.property.setLabel')} labelAction={setToggle}>
                <Select value={psetName} onValueChange={(v) => { setPsetName(v); setPropName(''); setCustomPropName(''); setValue(''); }}>
                  <SelectTrigger className="font-mono text-sm">
                    <SelectValue placeholder={t('propertyEditor.property.selectSet')} />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Existing psets on this entity */}
                    {existingStandardPsets.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-zinc-400">
                          {t('propertyEditor.shared.onElement')}
                        </div>
                        {existingStandardPsets.map((def) => (
                          <SelectItem key={def.name} value={def.name}>
                            <div className="flex items-center gap-2">
                              <span>{def.name}</span>
                              <Badge variant="secondary" className="h-4 px-1 text-2xs">{t('propertyEditor.shared.existing')}</Badge>
                            </div>
                          </SelectItem>
                        ))}
                      </>
                    )}
                    {/* Non-standard existing psets */}
                    {existingPsets.filter(p => !existingStandardPsets.some(d => d.name === p)).length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-zinc-400">
                          {t('propertyEditor.shared.existingCustom')}
                        </div>
                        {existingPsets.filter(p => !existingStandardPsets.some(d => d.name === p)).map((name) => (
                          <SelectItem key={name} value={name}>
                            <span>{name}</span>
                          </SelectItem>
                        ))}
                      </>
                    )}
                    {/* Available standard psets for this type */}
                    {availableStandardPsets.length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                          {t('propertyEditor.property.standardGroup', { schema: schemaVersion || 'IFC4', entityType })}
                        </div>
                        {availableStandardPsets.map((def) => (
                          <SelectItem key={def.name} value={def.name}>
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{def.name}</span>
                                <Badge variant="outline" className="h-4 px-1 text-2xs border-emerald-300 text-emerald-600">{t('propertyEditor.shared.new')}</Badge>
                              </div>
                              <span className="text-2xs text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.property.standardSetDescription') ? def.description : t('propertyEditor.property.standardSetDescription', { name: def.name })}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {inheritedFrom && isInheritedOnly({ inheritedFrom }, effectivePsetName) && (
              <p className="text-2xs text-sky-700 dark:text-sky-300">{t('propertyEditor.property.inheritedOverride', { psetName: effectivePsetName, typeName: inheritedFrom.typeName })}</p>
            )}
          </div>

          {/* Property Selection */}
          <div className="space-y-2">
            {propertySuggestions.length > 0 ? (
              <div className="space-y-2">
                <Field label={t('propertyEditor.property.label')}>
                  <Select value={propName} onValueChange={handlePropertySelect}>
                    <SelectTrigger className="font-mono text-sm">
                      <SelectValue placeholder={t('propertyEditor.property.select')} />
                    </SelectTrigger>
                    <SelectContent>
                      {propertySuggestions.map((prop) => (
                        <SelectItem key={prop.name} value={prop.name}>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{prop.name}</span>
                              <Badge variant="secondary" className="h-4 px-1 text-2xs">{t(getTypeNameKey(prop.type))}</Badge>
                            </div>
                            <span className="text-2xs text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.property.standardPropertyDescription') ? prop.description : t('propertyEditor.property.standardPropertyDescription', { name: prop.name })}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {/* Allow custom property name even for standard psets */}
                {!propName && (
                  <Field label={t('propertyEditor.property.label')} labelClassName="sr-only">
                    <Input
                      value={customPropName}
                      onChange={(e) => setCustomPropName(e.target.value)}
                      placeholder={t('propertyEditor.property.customPlaceholder')}
                      className="font-mono text-sm"
                    />
                  </Field>
                )}
              </div>
            ) : (
              <Field label={t('propertyEditor.property.label')}>
                <Input
                  value={customPropName}
                  onChange={(e) => setCustomPropName(e.target.value)}
                  placeholder={t('propertyEditor.property.examplePlaceholder')}
                  className="font-mono text-sm"
                />
              </Field>
            )}
          </div>

          {/* Type selector */}
          <Field label={t('propertyEditor.shared.type')}>
            <Select
              value={valueType.toString()}
              onValueChange={(v) => setValueType(parseInt(v) as PropertyValueType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PropertyValueType.String.toString()}>{t('propertyEditor.valueType.string')}</SelectItem>
                <SelectItem value={PropertyValueType.Real.toString()}>{t('propertyEditor.valueType.real')}</SelectItem>
                <SelectItem value={PropertyValueType.Integer.toString()}>{t('propertyEditor.valueType.integer')}</SelectItem>
                <SelectItem value={PropertyValueType.Boolean.toString()}>{t('propertyEditor.valueType.boolean')}</SelectItem>
                <SelectItem value={PropertyValueType.Label.toString()}>{t('propertyEditor.valueType.label')}</SelectItem>
                <SelectItem value={PropertyValueType.Identifier.toString()}>{t('propertyEditor.valueType.identifier')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/* Value input */}
          {valueType === PropertyValueType.Boolean ? (
            <Field
              label={t('propertyEditor.shared.value')}
              hint={value === 'true' ? t('propertyEditor.inline.true') : t('propertyEditor.inline.false')}
            >
              <Switch checked={value === 'true'} onCheckedChange={(checked) => setValue(checked ? 'true' : 'false')} />
            </Field>
          ) : (
            <Field label={t('propertyEditor.shared.value')}>
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t('propertyEditor.property.valuePlaceholder')}
                type={valueType === PropertyValueType.Real || valueType === PropertyValueType.Integer ? 'number' : 'text'}
                className="font-mono text-sm"
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>
            {t('propertyEditor.shared.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!effectivePsetName || !effectivePropName}>
            {t('propertyEditor.property.title')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
