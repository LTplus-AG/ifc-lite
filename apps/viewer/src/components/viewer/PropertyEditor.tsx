/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property Editor component for editing IFC property values inline.
 * Includes schema-aware property addition with IFC4 standard validation.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  X,
  Plus,
  Trash2,
  PenLine,
  Undo,
  Redo,
  Check,
  BookOpen,
  Tag,
  Layers,
  Ruler,
  Replace,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ComboInput } from '@/components/ui/combo-input';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  resolveReassignSchema,
  getReassignTargets,
  getPredefinedTypes,
  isKnownReassignTarget,
  isReassignableElement,
  COMMON_REASSIGN_TARGETS,
} from '@/lib/ifc-class-reassign';
import { useViewerStore } from '@/store';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import type { PropertyValue } from '@ifc-lite/mutations';
import {
  getPsetDefinitionsForType,
  getPropertiesForPset,
  CLASSIFICATION_SYSTEMS,
  type PsetPropertyDef,
  type PsetDefinition,
} from '@/lib/ifc4-pset-definitions';
import {
  getQtoDefinitionsForType,
  getQuantitiesForQto,
  getQuantityUnit,
  type QtoQuantityDef,
  type QtoDefinition,
} from '@/lib/ifc4-qto-definitions';
import { useTranslation, type TranslationKey } from '@/i18n';
import { hasActiveTranslation } from '@/i18n/registry';
import { INLINE_VALUE_TYPES, MATERIAL_CATEGORIES } from './property-editor-options';
import { addToPropertySet, isInheritedOnly, type InheritedSets } from '@/lib/properties/add-to-property-set';
import { addClassificationAssociation, addMaterialAssociation } from '@/lib/authoring/associations';

// ── Edit-deck button styling ────────────────────────────────────────────────
// Data-enrichment actions (Property / Quantity / Classification / Material)
// live as quiet icon keys inside one segmented control — discoverable via
// tooltip, compact enough to leave room for the headline action.
const EDIT_TOOL_CLS =
  'h-7 w-8 rounded-none border-0 bg-transparent text-zinc-500 shadow-none transition-colors hover:bg-indigo-500/10 hover:text-indigo-600 focus-visible:bg-indigo-500/10 dark:text-zinc-400 dark:hover:bg-indigo-400/15 dark:hover:text-indigo-300';

// The structural "Reassign class" action is elevated as a distinct accent
// affordance — it transforms the element rather than adding data to it.
const RECLASS_TOOL_CLS =
  'h-7 min-w-0 gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-300/70 bg-indigo-500/10 shadow-none transition-colors hover:bg-indigo-500/20 hover:text-indigo-800 dark:text-indigo-300 dark:ring-indigo-700/60 dark:bg-indigo-500/10 dark:hover:text-indigo-200';

interface PropertyEditorProps {
  modelId: string;
  entityId: number;
  psetName: string;
  propName: string;
  currentValue: unknown;
  currentType?: PropertyValueType;
  editScope?: PropertyEditScope;
  onClose?: () => void;
}

export interface PropertyEditScope {
  mode: 'type' | 'inherited';
  typeEntityName: string;
  affectedCount: number;
}

/**
 * Inline property value editor with pen icon on the right.
 * Supports keyboard: Enter to save, Escape to cancel.
 */
export function PropertyEditor({
  modelId,
  entityId,
  psetName,
  propName,
  currentValue,
  currentType = PropertyValueType.String,
  editScope,
  onClose,
}: PropertyEditorProps) {
  const { t } = useTranslation();
  const setProperty = useViewerStore((s) => s.setProperty);
  const deleteProperty = useViewerStore((s) => s.deleteProperty);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [value, setValue] = useState<string>(formatValue(currentValue));
  const [valueType, setValueType] = useState<PropertyValueType>(detectValueType(currentValue, currentType));
  const [isEditing, setIsEditing] = useState(false);
  const [showScopeConfirm, setShowScopeConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const initialValue = formatValue(currentValue);
  const initialType = detectValueType(currentValue, currentType);
  const isUnchanged = value === initialValue && valueType === initialType;

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commitSave = useCallback(() => {
    const parsedValue = parseValue(value, valueType);
    if (parsedValue === PARSE_INVALID) {
      return toast.error(t('propertyEditor.inline.invalid', { value, type: t(getTypeNameKey(valueType)) }));
    }
    // Normalize model ID for legacy models
    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    setProperty(normalizedModelId, entityId, psetName, propName, parsedValue, valueType);
    bumpMutationVersion();
    setShowScopeConfirm(false);
    setIsEditing(false);
    onClose?.();
  }, [modelId, entityId, psetName, propName, value, valueType, setProperty, bumpMutationVersion, onClose, t]);

  const handleSave = useCallback(() => {
    if (editScope && !showScopeConfirm && !isUnchanged) {
      setShowScopeConfirm(true);
      return;
    }
    commitSave();
  }, [editScope, showScopeConfirm, isUnchanged, commitSave]);

  const handleDelete = useCallback(() => {
    // Normalize model ID for legacy models
    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    deleteProperty(normalizedModelId, entityId, psetName, propName);
    bumpMutationVersion();
    setShowScopeConfirm(false);
    setIsEditing(false);
    onClose?.();
  }, [modelId, entityId, psetName, propName, deleteProperty, bumpMutationVersion, onClose]);

  const handleCancel = useCallback(() => {
    setValue(formatValue(currentValue));
    setValueType(detectValueType(currentValue, currentType));
    setShowScopeConfirm(false);
    setIsEditing(false);
    onClose?.();
  }, [currentValue, currentType, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (showScopeConfirm) {
        setShowScopeConfirm(false);
      } else {
        handleCancel();
      }
    }
  }, [handleSave, handleCancel, showScopeConfirm]);

  const displayValue = formatDisplayValue(currentValue, t);

  // Non-editing view: value with pen icon on right (always visible)
  if (!isEditing) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <button type="button"
          className="font-mono text-zinc-900 dark:text-zinc-100 select-all break-words flex-1 min-w-0 cursor-text border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setIsEditing(true)}
          title={t('propertyEditor.inline.clickToEdit')}
        >
          {displayValue}
        </button>
        <IconButton
          label={t('propertyEditor.inline.editProperty')}
          tooltipSide="left"
          className="h-5 w-5 shrink-0 hover:bg-overlay-accent-soft"
          onClick={() => setIsEditing(true)}
        >
          <PenLine className="h-3 w-3 text-overlay-accent" />
        </IconButton>
      </div>
    );
  }

  // Editing view: inline input with type selector and action buttons
  return (
    <div className="flex flex-col gap-2 p-2 -mx-2 bg-overlay-accent-soft border border-overlay-accent/40 rounded">
      {/* Value input */}
      <div className="flex items-center gap-2">
        {valueType === PropertyValueType.Boolean || valueType === PropertyValueType.Logical ? (
          // Tri-state: a boolean property value is optional in IFC, so "Unset"
          // is a first-class choice — we never silently coerce to false. An
          // empty `value` ('') means unset (issue #1107).
          <div className="flex items-center gap-1 flex-1" role="radiogroup" aria-label={t('propertyEditor.inline.booleanAria')}>
            {([['', t('propertyEditor.inline.unset')], ['true', t('propertyEditor.inline.true')], ['false', t('propertyEditor.inline.false')]] as const).map(([v, label]) => {
              const active = value === v;
              return (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setValue(v);
                    if (showScopeConfirm) setShowScopeConfirm(false);
                  }}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                    active
                      ? 'bg-overlay-accent text-overlay-halo border-overlay-accent'
                      : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  } ${v === '' ? 'italic' : ''}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : (
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (showScopeConfirm) setShowScopeConfirm(false);
            }}
            onKeyDown={handleKeyDown}
            className="h-7 text-xs font-mono flex-1 bg-white dark:bg-zinc-900"
            placeholder={t('propertyEditor.inline.enterValue')}
            type={valueType === PropertyValueType.Real || valueType === PropertyValueType.Integer ? 'number' : 'text'}
            step={valueType === PropertyValueType.Real ? 'any' : undefined}
          />
        )}

        {/* Action buttons */}
        <IconButton
          label={editScope && !showScopeConfirm && !isUnchanged ? t('propertyEditor.inline.reviewScope') : t('propertyEditor.inline.save')}
          className="h-6 w-6 hover:bg-green-100 dark:hover:bg-green-900/30"
          onClick={handleSave}
        >
          <Check className="h-3.5 w-3.5 text-green-600" />
        </IconButton>
        <IconButton
          label={t('propertyEditor.inline.cancel')}
          className="h-6 w-6 hover:bg-zinc-200 dark:hover:bg-zinc-700"
          onClick={handleCancel}
        >
          <X className="h-3.5 w-3.5 text-zinc-500" />
        </IconButton>
        <IconButton
          label={t('propertyEditor.inline.delete')}
          className="h-6 w-6 hover:bg-red-100 dark:hover:bg-red-900/30"
          onClick={handleDelete}
        >
          <Trash2 className="h-3.5 w-3.5 text-red-500" />
        </IconButton>
      </div>

      {/* Type selector - always visible */}
      <div className="flex flex-wrap gap-1">
        {INLINE_VALUE_TYPES.map(({ type, labelKey }) => (
          <Button
            key={type}
            variant={valueType === type ? 'default' : 'outline'}
            size="sm"
            className="h-5 px-2 text-[10px]"
            onClick={() => {
              setValueType(type);
              if (showScopeConfirm) setShowScopeConfirm(false);
              // Convert value if switching to/from boolean
              if (type === PropertyValueType.Boolean) {
                const boolVal = value.toLowerCase() === 'true' || value === '1' || value === 'yes';
                setValue(boolVal ? 'true' : 'false');
              }
            }}
          >
            {t(labelKey)}
          </Button>
        ))}
      </div>

      {showScopeConfirm && editScope && (
        <div className="border border-indigo-200 dark:border-indigo-800/60 bg-white/75 dark:bg-zinc-950/60 px-2.5 py-2 text-[11px]">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">
            {editScope.mode === 'type'
              ? t('propertyEditor.inline.scopeType', { typeEntityName: editScope.typeEntityName })
              : t('propertyEditor.inline.scopeInherited', { typeEntityName: editScope.typeEntityName })}
          </div>
          <div className="mt-0.5 text-zinc-600 dark:text-zinc-400">
            {t('propertyEditor.inline.scopeImpact', { count: editScope.affectedCount })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-6 rounded-none border-indigo-300 text-[10px] uppercase tracking-wide hover:bg-indigo-50 dark:border-indigo-700 dark:hover:bg-indigo-950/30"
              onClick={commitSave}
            >
              {t('propertyEditor.inline.applyToType')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 rounded-none px-2 text-[10px] uppercase tracking-wide"
              onClick={() => setShowScopeConfirm(false)}
            >
              {t('propertyEditor.inline.keepEditing')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Schema-Aware Property Dialog
// ============================================================================

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
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">{t('propertyEditor.property.setLabel')}</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => { setIsCustomPset(!isCustomPset); setPsetName(''); setCustomPsetName(''); setPropName(''); setCustomPropName(''); }}
              >
                {isCustomPset ? t('propertyEditor.shared.useStandard') : t('propertyEditor.shared.customName')}
              </Button>
            </div>
            {isCustomPset ? (
              <Input
                value={customPsetName}
                onChange={(e) => setCustomPsetName(e.target.value)}
                placeholder={t('propertyEditor.property.customSetPlaceholder')}
                className="font-mono text-sm"
              />
            ) : (
              <Select value={psetName} onValueChange={(v) => { setPsetName(v); setPropName(''); setCustomPropName(''); setValue(''); }}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue placeholder={t('propertyEditor.property.selectSet')} />
                </SelectTrigger>
                <SelectContent>
                  {/* Existing psets on this entity */}
                  {existingStandardPsets.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                        {t('propertyEditor.shared.onElement')}
                      </div>
                      {existingStandardPsets.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex items-center gap-2">
                            <span>{def.name}</span>
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">{t('propertyEditor.shared.existing')}</Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                  {/* Non-standard existing psets */}
                  {existingPsets.filter(p => !existingStandardPsets.some(d => d.name === p)).length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
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
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        {t('propertyEditor.property.standardGroup', { schema: schemaVersion || 'IFC4', entityType })}
                      </div>
                      {availableStandardPsets.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{def.name}</span>
                              <Badge variant="outline" className="h-4 px-1 text-[9px] border-emerald-300 text-emerald-600">{t('propertyEditor.shared.new')}</Badge>
                            </div>
                            <span className="text-[10px] text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.property.standardSetDescription') ? def.description : t('propertyEditor.property.standardSetDescription', { name: def.name })}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            )}
            {inheritedFrom && isInheritedOnly({ inheritedFrom }, effectivePsetName) && (
              <p className="text-[11px] text-sky-700 dark:text-sky-300">{t('propertyEditor.property.inheritedOverride', { psetName: effectivePsetName, typeName: inheritedFrom.typeName })}</p>
            )}
          </div>

          {/* Property Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.property.label')}</Label>
            {propertySuggestions.length > 0 ? (
              <div className="space-y-2">
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
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">{t(getTypeNameKey(prop.type))}</Badge>
                          </div>
                          <span className="text-[10px] text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.property.standardPropertyDescription') ? prop.description : t('propertyEditor.property.standardPropertyDescription', { name: prop.name })}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Allow custom property name even for standard psets */}
                {!propName && (
                  <Input
                    value={customPropName}
                    onChange={(e) => setCustomPropName(e.target.value)}
                    placeholder={t('propertyEditor.property.customPlaceholder')}
                    className="font-mono text-sm"
                  />
                )}
              </div>
            ) : (
              <Input
                value={customPropName}
                onChange={(e) => setCustomPropName(e.target.value)}
                placeholder={t('propertyEditor.property.examplePlaceholder')}
                className="font-mono text-sm"
              />
            )}
          </div>

          {/* Type selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.shared.type')}</Label>
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
          </div>

          {/* Value input */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.shared.value')}</Label>
            {valueType === PropertyValueType.Boolean ? (
              <div className="flex items-center gap-3">
                <Switch
                  checked={value === 'true'}
                  onCheckedChange={(checked) => setValue(checked ? 'true' : 'false')}
                />
                <span className="text-sm text-zinc-500">{value === 'true' ? t('propertyEditor.inline.true') : t('propertyEditor.inline.false')}</span>
              </div>
            ) : (
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t('propertyEditor.property.valuePlaceholder')}
                type={valueType === PropertyValueType.Real || valueType === PropertyValueType.Integer ? 'number' : 'text'}
                className="font-mono text-sm"
              />
            )}
          </div>
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

// ============================================================================
// Classification Dialog
// ============================================================================

interface AddClassificationDialogProps {
  modelId: string;
  entityId: number;
  entityType: string;
}

/** Dialog for adding a classification reference (Uniclass, OmniClass,
 *  MasterFormat, etc.) as a real IfcClassificationReference (#5876). */
export function AddClassificationDialog({ modelId, entityId, entityType }: AddClassificationDialogProps) {
  const { t, locale } = useTranslation();

  const [open, setOpen] = useState(false);
  const [system, setSystem] = useState('');
  const [customSystem, setCustomSystem] = useState('');
  const [identification, setIdentification] = useState('');
  const [name, setName] = useState('');

  const effectiveSystem = system === '__custom__' ? customSystem : system;

  const handleSubmit = useCallback(() => {
    if (!effectiveSystem || !identification) return;
    const result = addClassificationAssociation(modelId, entityId, { system: effectiveSystem, identification, name });
    if (!result.ok) return toast.error(t(result.reasonKey));

    // Reset form
    setSystem('');
    setCustomSystem('');
    setIdentification('');
    setName('');
    setOpen(false);
  }, [modelId, entityId, effectiveSystem, identification, name, t]);

  return (
    <Dialog open={open} onOpenChange={(o) => {
      setOpen(o);
      if (!o) { setSystem(''); setCustomSystem(''); setIdentification(''); setName(''); }
    }}>
      <DialogTrigger asChild>
        <IconButton label={t('propertyEditor.classification.trigger')} className={EDIT_TOOL_CLS}>
          <Tag className="h-3.5 w-3.5" />
        </IconButton>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4" />
            {t('propertyEditor.classification.title')}
          </DialogTitle>
          <DialogDescription>
            {t('propertyEditor.classification.description', { entityType })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Classification System */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.classification.system')}</Label>
            <Select value={system} onValueChange={setSystem}>
              <SelectTrigger>
                <SelectValue placeholder={t('propertyEditor.classification.selectSystem')} />
              </SelectTrigger>
              <SelectContent>
                {CLASSIFICATION_SYSTEMS.map((cs) => (
                  <SelectItem key={cs.name} value={cs.name}>
                    <div className="flex flex-col">
                      <span className="font-medium">{cs.name}</span>
                      <span className="text-[10px] text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.classification.standardSystemDescription') ? cs.description : t('propertyEditor.classification.standardSystemDescription', { name: cs.name })}</span>
                    </div>
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">
                  <span className="text-zinc-500">{t('propertyEditor.classification.customSystem')}</span>
                </SelectItem>
              </SelectContent>
            </Select>
            {system === '__custom__' && (
              <Input
                value={customSystem}
                onChange={(e) => setCustomSystem(e.target.value)}
                placeholder={t('propertyEditor.classification.systemPlaceholder')}
                className="mt-2"
              />
            )}
          </div>

          {/* Identification (code) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.classification.code')}</Label>
            <Input
              value={identification}
              onChange={(e) => setIdentification(e.target.value)}
              placeholder={t('propertyEditor.classification.codePlaceholder')}
              className="font-mono"
            />
            <p className="text-[10px] text-zinc-400">{t('propertyEditor.classification.codeHelp')}</p>
          </div>

          {/* Name (optional) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.classification.name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('propertyEditor.classification.namePlaceholder')}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('propertyEditor.shared.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!effectiveSystem || !identification}>
            {t('propertyEditor.classification.title')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Material Dialog
// ============================================================================

interface AddMaterialDialogProps {
  modelId: string;
  entityId: number;
  entityType: string;
}

/** Dialog for assigning a material as a real IfcMaterial association (#5876). */
export function AddMaterialDialog({ modelId, entityId, entityType }: AddMaterialDialogProps) {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  const [materialName, setMaterialName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = useCallback(() => {
    if (!materialName) return;
    const result = addMaterialAssociation(modelId, entityId, { name: materialName, category, description });
    if (!result.ok) return toast.error(t(result.reasonKey));

    // Reset form
    setMaterialName('');
    setCategory('');
    setDescription('');
    setOpen(false);
  }, [modelId, entityId, materialName, category, description, t]);

  // Common material categories (module-level constant used below)
  const materialCategories = MATERIAL_CATEGORIES;

  return (
    <Dialog open={open} onOpenChange={(o) => {
      setOpen(o);
      if (!o) { setMaterialName(''); setCategory(''); setDescription(''); }
    }}>
      <DialogTrigger asChild>
        <IconButton label={t('propertyEditor.material.trigger')} className={EDIT_TOOL_CLS}>
          <Layers className="h-3.5 w-3.5" />
        </IconButton>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            {t('propertyEditor.material.title')}
          </DialogTitle>
          <DialogDescription>
            {t('propertyEditor.material.description', { entityType })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Material Name */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.material.name')}</Label>
            <Input
              value={materialName}
              onChange={(e) => setMaterialName(e.target.value)}
              placeholder={t('propertyEditor.material.namePlaceholder')}
              className="font-mono"
            />
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.material.category')}</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder={t('propertyEditor.material.selectCategory')} />
              </SelectTrigger>
              <SelectContent>
                {materialCategories.map((category) => (
                  <SelectItem key={category.value} value={category.value}>{t(category.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.material.descriptionLabel')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('propertyEditor.material.descriptionPlaceholder')}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('propertyEditor.shared.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!materialName}>
            {t('propertyEditor.material.title')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Quantity Dialog
// ============================================================================

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
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">{t('propertyEditor.quantity.setLabel')}</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => { setIsCustomQto(!isCustomQto); setQtoName(''); setCustomQtoName(''); setQuantityName(''); setCustomQuantityName(''); }}
              >
                {isCustomQto ? t('propertyEditor.shared.useStandard') : t('propertyEditor.shared.customName')}
              </Button>
            </div>
            {isCustomQto ? (
              <Input
                value={customQtoName}
                onChange={(e) => setCustomQtoName(e.target.value)}
                placeholder={t('propertyEditor.quantity.customSetPlaceholder')}
                className="font-mono text-sm"
              />
            ) : (
              <Select value={qtoName} onValueChange={(v) => { setQtoName(v); setQuantityName(''); setCustomQuantityName(''); setValue(''); }}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue placeholder={t('propertyEditor.quantity.selectSet')} />
                </SelectTrigger>
                <SelectContent>
                  {existingStandardQtos.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                        {t('propertyEditor.shared.onElement')}
                      </div>
                      {existingStandardQtos.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex items-center gap-2">
                            <span>{def.name}</span>
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">{t('propertyEditor.shared.existing')}</Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                  {existingQtos.filter(q => !existingStandardQtos.some(d => d.name === q)).length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
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
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        {t('propertyEditor.quantity.standardGroup', { entityType })}
                      </div>
                      {availableStandardQtos.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{def.name}</span>
                              <Badge variant="outline" className="h-4 px-1 text-[9px] border-emerald-300 text-emerald-600">{t('propertyEditor.shared.new')}</Badge>
                            </div>
                            <span className="text-[10px] text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.quantity.standardSetDescription') ? def.description : t('propertyEditor.quantity.standardSetDescription', { name: def.name })}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Quantity Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('propertyEditor.quantity.label')}</Label>
            {quantitySuggestions.length > 0 ? (
              <div className="space-y-2">
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
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">{qty.unit}</Badge>
                          </div>
                          <span className="text-[10px] text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.quantity.standardQuantityDescription') ? qty.description : t('propertyEditor.quantity.standardQuantityDescription', { name: qty.name })}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!quantityName && (
                  <Input
                    value={customQuantityName}
                    onChange={(e) => setCustomQuantityName(e.target.value)}
                    placeholder={t('propertyEditor.quantity.customPlaceholder')}
                    className="font-mono text-sm"
                  />
                )}
              </div>
            ) : (
              <Input
                value={customQuantityName}
                onChange={(e) => setCustomQuantityName(e.target.value)}
                placeholder={t('propertyEditor.quantity.examplePlaceholder')}
                className="font-mono text-sm"
              />
            )}
          </div>

          {/* Value input */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              {t('propertyEditor.shared.value')}
              {quantityName && (
                <span className="ml-2 text-xs text-zinc-400 font-normal">
                  ({getQuantityUnit(quantityType)})
                </span>
              )}
            </Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('propertyEditor.quantity.numericPlaceholder')}
              type="number"
              step="any"
              className="font-mono text-sm"
            />
          </div>
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

// ============================================================================
// Reassign IFC Class (retype)
// ============================================================================

interface ReassignClassDialogProps {
  modelId: string;
  entityId: number;
  /** The element's current IFC class, e.g. "IfcBuildingElementProxy". */
  entityType: string;
  schemaVersion?: string;
}

/**
 * Reassign an entity's IFC class in place ("retype"): expressId is
 * unchanged, so geometry/placement/representation and every IfcRel*
 * reference carry over; the new class materializes on STEP export. Mirrors
 * IfcOpenShell's `reassign_class`. Best for building-element subtypes
 * (Proxy ↔ Column/Beam/Member/Plate/Wall) sharing the IfcElement layout.
 */
export function ReassignClassDialog({ modelId, entityId, entityType, schemaVersion }: ReassignClassDialogProps) {
  const { t } = useTranslation();
  const setEntityType = useViewerStore((s) => s.setEntityType);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [predefinedType, setPredefinedType] = useState('');

  const schema = useMemo(() => resolveReassignSchema(schemaVersion), [schemaVersion]);
  const targets = useMemo(() => getReassignTargets(schema), [schema]);
  const predefinedOptions = useMemo(
    () => (target.trim() ? getPredefinedTypes(schema, target.trim()) : []),
    [schema, target],
  );
  const quickTargets = useMemo(
    () => COMMON_REASSIGN_TARGETS.filter((t) => t.toUpperCase() !== entityType.toUpperCase()),
    [entityType],
  );

  const trimmedTarget = target.trim();
  const targetChanged = trimmedTarget.length > 0 && trimmedTarget.toUpperCase() !== entityType.toUpperCase();
  const knownTarget = trimmedTarget.length > 0 && isKnownReassignTarget(schema, trimmedTarget);
  const validKeyword = /^[Ii][Ff][Cc][A-Za-z][A-Za-z0-9_]*$/.test(trimmedTarget);
  // Allow apply when the class changes, or when only setting a predefined type
  // on the same class (the retype API carries that too).
  const canApply = validKeyword && (targetChanged || (trimmedTarget.length > 0 && predefinedType.length > 0));

  const reset = useCallback(() => { setTarget(''); setPredefinedType(''); }, []);

  // Drop a predefined type that the newly-chosen class doesn't define.
  useEffect(() => {
    if (predefinedType && !predefinedOptions.includes(predefinedType)) setPredefinedType('');
  }, [predefinedOptions, predefinedType]);

  const handleApply = useCallback(() => {
    if (!canApply) return;
    let normalizedModelId = modelId;
    if (modelId === 'legacy') normalizedModelId = '__legacy__';
    setEntityType(normalizedModelId, entityId, trimmedTarget, predefinedType || null);
    bumpMutationVersion();
    reset();
    setOpen(false);
  }, [canApply, modelId, entityId, trimmedTarget, predefinedType, setEntityType, bumpMutationVersion, reset]);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title={t('propertyEditor.reassign.trigger')} className={RECLASS_TOOL_CLS}>
          <Replace className="h-3.5 w-3.5 shrink-0" />
          <span>{t('propertyEditor.reassign.action')}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Replace className="h-4 w-4" />
            {t('propertyEditor.reassign.title')}
          </DialogTitle>
          <DialogDescription>
            {t('propertyEditor.reassign.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* current → target */}
          <div className="flex items-center gap-2 rounded-md border border-indigo-200/70 bg-indigo-50/40 px-3 py-2.5 dark:border-indigo-900/60 dark:bg-indigo-950/20">
            <code className="flex-1 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400" title={entityType}>{entityType}</code>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            <code
              className={cn(
                'flex-1 truncate text-right font-mono text-[11px] font-medium',
                targetChanged ? 'text-indigo-600 dark:text-indigo-300' : 'text-zinc-400 dark:text-zinc-600',
              )}
              title={trimmedTarget || undefined}
            >
              {trimmedTarget || '—'}
            </code>
          </div>

          {/* quick picks */}
          {quickTargets.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t('propertyEditor.reassign.common')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {quickTargets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTarget(t)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
                      trimmedTarget === t
                        ? 'border-indigo-400 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                        : 'border-zinc-200 text-zinc-600 hover:border-indigo-300 hover:bg-indigo-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-indigo-950/30',
                    )}
                  >
                    {t.replace(/^Ifc/, '')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* searchable full list */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">{t('propertyEditor.reassign.targetClass')}</Label>
            <ComboInput value={target} onChange={setTarget} options={targets} placeholder={t('propertyEditor.reassign.searchPlaceholder')} />
            {trimmedTarget.length > 0 && !knownTarget && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {t('propertyEditor.reassign.nonStandard', { schema })}
              </p>
            )}
          </div>

          {/* predefined type */}
          {predefinedOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                {t('propertyEditor.reassign.predefinedType')}
              </Label>
              <Select value={predefinedType || '__none__'} onValueChange={(v) => setPredefinedType(v === '__none__' ? '' : v)}>
                <SelectTrigger className="font-mono text-sm"><SelectValue placeholder={t('propertyEditor.reassign.none')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('propertyEditor.reassign.none')}</SelectItem>
                  {predefinedOptions.map((p) => (<SelectItem key={p} value={p}>{p}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
            {t('propertyEditor.reassign.help')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { reset(); setOpen(false); }}>{t('propertyEditor.shared.cancel')}</Button>
          <Button size="sm" onClick={handleApply} disabled={!canApply}>
            <Check className="mr-1 h-3.5 w-3.5" /> {t('propertyEditor.reassign.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline chip surfacing a pending reassignment for the selected element. Reads
 * the overlay (re-rendering on `mutationVersion`) so a retype is visible in the
 * panel immediately, before the model is re-exported / reloaded.
 */
export function ReassignBadge({ modelId, entityId, entityType }: { modelId: string; entityId: number; entityType: string }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const pending = useMemo(() => {
    let mid = modelId;
    if (mid === 'legacy') mid = '__legacy__';
    const view = mutationViews.get(mid);
    const m = view?.getEntityTypeMutation?.(entityId) ?? null;
    if (!m) return null;
    // A no-op (same class, no predefined type) isn't worth surfacing.
    if (m.newType.toUpperCase() === entityType.toUpperCase() && !m.predefinedType) return null;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, entityId, entityType, mutationViews, mutationVersion]);

  if (!pending) return null;
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-indigo-200/70 bg-indigo-50/50 px-2 py-1 text-[11px] dark:border-indigo-900/60 dark:bg-indigo-950/25">
      <Replace className="h-3 w-3 shrink-0 text-indigo-500" />
      <span className="text-zinc-500 dark:text-zinc-400">{t('propertyEditor.reassign.badge')}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-indigo-400" />
      <code className="font-mono font-medium text-indigo-600 dark:text-indigo-300">{pending.newType}</code>
      {pending.predefinedType && (
        <code className="font-mono text-indigo-500/80 dark:text-indigo-300/70">· {pending.predefinedType}</code>
      )}
      <span className="ml-auto text-zinc-400 dark:text-zinc-500">{t('propertyEditor.reassign.onExport')}</span>
    </div>
  );
}

// ============================================================================
// Edit Toolbar (combines all add actions)
// ============================================================================

interface EditToolbarProps {
  modelId: string;
  entityId: number;
  entityType: string;
  existingPsets: string[];
  existingQtos?: string[];
  schemaVersion?: string;
  inheritedFrom?: InheritedSets | null;
}

/**
 * Edit mode toolbar with dropdown for adding properties, classifications, materials, and quantities.
 * Schema-aware: filters available property/quantity sets based on entity type.
 */
export function EditToolbar({ modelId, entityId, entityType, existingPsets, existingQtos, schemaVersion, inheritedFrom }: EditToolbarProps) {
  // Reassign is only meaningful for occurrence building elements — not type
  // entities, spaces, or materials.
  const canReassign = isReassignableElement(resolveReassignSchema(schemaVersion), entityType);
  return (
    <div className="panel-container relative -mx-3 -mt-3 mb-3 flex flex-col gap-2 border-b border-zinc-200 bg-gradient-to-b from-zinc-50/80 to-transparent px-3 pb-2.5 pt-3 dark:border-zinc-800 dark:from-zinc-900/50">
      {/* live-edit accent hairline */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/50 to-transparent"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Data-enrichment cluster — one segmented control of icon keys */}
          <div className="inline-flex items-center overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-zinc-200 divide-x divide-zinc-200 dark:bg-zinc-800/50 dark:ring-zinc-700 dark:divide-zinc-700">
            <NewPropertyDialog
              modelId={modelId}
              entityId={entityId}
              entityType={entityType}
              existingPsets={existingPsets}
              schemaVersion={schemaVersion}
              inheritedFrom={inheritedFrom}
            />
            <AddQuantityDialog
              modelId={modelId}
              entityId={entityId}
              entityType={entityType}
              existingQtos={existingQtos ?? []}
            />
            <AddClassificationDialog
              modelId={modelId}
              entityId={entityId}
              entityType={entityType}
            />
            <AddMaterialDialog
              modelId={modelId}
              entityId={entityId}
              entityType={entityType}
            />
          </div>
          {/* Structural transform — elevated accent action */}
          {canReassign && (
            <ReassignClassDialog
              modelId={modelId}
              entityId={entityId}
              entityType={entityType}
              schemaVersion={schemaVersion}
            />
          )}
        </div>
        <UndoRedoButtons modelId={modelId} />
      </div>
      {canReassign && <ReassignBadge modelId={modelId} entityId={entityId} entityType={entityType} />}
    </div>
  );
}

// ============================================================================
// Undo/Redo
// ============================================================================

interface UndoRedoButtonsProps {
  modelId: string;
}

/**
 * Undo/Redo buttons for property mutations
 */
export function UndoRedoButtons({ modelId }: UndoRedoButtonsProps) {
  const { t } = useTranslation();
  const canUndo = useViewerStore((s) => s.canUndo);
  const canRedo = useViewerStore((s) => s.canRedo);
  const undo = useViewerStore((s) => s.undo);
  const redo = useViewerStore((s) => s.redo);

  // Normalize model ID for legacy models
  let normalizedModelId = modelId;
  if (modelId === 'legacy') {
    normalizedModelId = '__legacy__';
  }

  const handleUndo = useCallback(() => {
    undo(normalizedModelId);
  }, [normalizedModelId, undo]);

  const handleRedo = useCallback(() => {
    redo(normalizedModelId);
  }, [normalizedModelId, redo]);

  return (
    <div className="flex items-center gap-1">
      <IconButton
        label={t('propertyEditor.history.undo')}
        className="h-7 w-7"
        onClick={handleUndo}
        disabled={!canUndo(normalizedModelId)}
      >
        <Undo className="h-4 w-4" />
      </IconButton>
      <IconButton
        label={t('propertyEditor.history.redo')}
        className="h-7 w-7"
        onClick={handleRedo}
        disabled={!canRedo(normalizedModelId)}
      >
        <Redo className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract the raw value from typed IFC values.
 * Handles: arrays like [IFCLABEL, value], strings like "IFCLABEL,value"
 */
function extractRawValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  // Handle typed value arrays [IFCTYPENAME, actualValue]
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[0].toUpperCase().startsWith('IFC')) {
    return value[1];
  }

  // Handle string format "IFCTYPENAME,actualValue"
  if (typeof value === 'string') {
    const match = value.match(/^(IFC[A-Z0-9_]+),(.*)$/i);
    if (match) {
      return match[2]; // Return just the value part
    }
  }

  return value;
}

function formatValue(value: unknown): string {
  const raw = extractRawValue(value);
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number') return raw.toString();
  if (Array.isArray(raw)) return JSON.stringify(raw);
  return String(raw);
}

function formatDisplayValue(value: unknown, t: (key: TranslationKey) => string): string {
  const raw = extractRawValue(value);
  if (raw === null || raw === undefined) return '\u2014';
  if (typeof raw === 'boolean') {
    return raw ? t('propertyEditor.inline.true') : t('propertyEditor.inline.false');
  }
  if (typeof raw === 'number') {
    return Number.isInteger(raw)
      ? raw.toLocaleString()
      : raw.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (Array.isArray(raw)) return JSON.stringify(raw);

  // Handle boolean strings (STEP enum format)
  const strVal = String(raw);
  const upper = strVal.toUpperCase();
  if (upper === '.T.') return t('propertyEditor.inline.true');
  if (upper === '.F.') return t('propertyEditor.inline.false');
  if (upper === '.U.') return t('propertyEditor.inline.unknown');
  return strVal;
}

function detectValueType(value: unknown, fallback: PropertyValueType): PropertyValueType {
  // First check if it's a typed value and extract the type
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    const typeName = value[0].toUpperCase();
    if (typeName === 'IFCBOOLEAN' || typeName === 'IFCLOGICAL') return PropertyValueType.Boolean;
    if (typeName === 'IFCREAL') return PropertyValueType.Real;
    if (typeName === 'IFCINTEGER') return PropertyValueType.Integer;
    if (typeName === 'IFCIDENTIFIER') return PropertyValueType.Identifier;
    if (typeName === 'IFCLABEL') return PropertyValueType.Label;
    if (typeName === 'IFCTEXT') return PropertyValueType.String;
  }

  // Check string format "IFCTYPE,value"
  if (typeof value === 'string') {
    const match = value.match(/^(IFC[A-Z0-9_]+),/i);
    if (match) {
      const typeName = match[1].toUpperCase();
      if (typeName === 'IFCBOOLEAN' || typeName === 'IFCLOGICAL') return PropertyValueType.Boolean;
      if (typeName === 'IFCREAL') return PropertyValueType.Real;
      if (typeName === 'IFCINTEGER') return PropertyValueType.Integer;
      if (typeName === 'IFCIDENTIFIER') return PropertyValueType.Identifier;
      if (typeName === 'IFCLABEL') return PropertyValueType.Label;
      if (typeName === 'IFCTEXT') return PropertyValueType.String;
    }

    // Check for boolean enum values
    const upper = value.toUpperCase();
    if (upper === '.T.' || upper === '.F.' || upper === '.U.') {
      return PropertyValueType.Boolean;
    }
  }

  // Check raw value type
  const raw = extractRawValue(value);
  if (typeof raw === 'boolean') return PropertyValueType.Boolean;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? PropertyValueType.Integer : PropertyValueType.Real;
  }

  return fallback;
}

function getTypeNameKey(type: PropertyValueType): TranslationKey {
  switch (type) {
    case PropertyValueType.Label: return 'propertyEditor.valueType.label';
    case PropertyValueType.Identifier: return 'propertyEditor.valueType.identifier';
    case PropertyValueType.Real: return 'propertyEditor.valueType.real';
    case PropertyValueType.Integer: return 'propertyEditor.valueType.integer';
    case PropertyValueType.Boolean: return 'propertyEditor.valueType.boolean';
    case PropertyValueType.Logical: return 'propertyEditor.valueType.logical';
    default: return 'propertyEditor.valueType.string';
  }
}

/** Sentinel: a Real/Integer {@link parseValue} input isn't a number at all — callers must refuse the save. */
export const PARSE_INVALID = Symbol('property-editor-parse-invalid');

export function parseValue(value: string, type: PropertyValueType): PropertyValue | typeof PARSE_INVALID {
  switch (type) {
    // Empty = unset → null for both, matching Boolean/Logical below.
    case PropertyValueType.Real:
      return value === '' ? null : (Number.isNaN(parseFloat(value)) ? PARSE_INVALID : parseFloat(value));
    case PropertyValueType.Integer:
      return value === '' ? null : (Number.isNaN(parseInt(value, 10)) ? PARSE_INVALID : parseInt(value, 10));
    case PropertyValueType.Boolean:
    case PropertyValueType.Logical:
      // Empty = unset → null (encodes to the table's 255 sentinel, serialises
      // to `$`). Only an explicit choice writes a concrete boolean.
      if (value === '') return null;
      return value.toLowerCase() === 'true';
    default:
      return value;
  }
}
