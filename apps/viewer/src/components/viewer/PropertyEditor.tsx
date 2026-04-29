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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
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
  }, [modelId, entityId, psetName, propName, value, valueType, setProperty, bumpMutationVersion, onClose]);

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

  const displayValue = formatDisplayValue(currentValue);

  // Non-editing view: value with pen icon on right (always visible)
  if (!isEditing) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="font-mono text-zinc-900 dark:text-zinc-100 select-all break-words flex-1 min-w-0 cursor-text"
          onClick={() => setIsEditing(true)}
          title="Click to edit"
        >
          {displayValue}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0 hover:bg-purple-100 dark:hover:bg-purple-900/30"
              onClick={() => setIsEditing(true)}
            >
              <PenLine className="h-3 w-3 text-purple-500" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Edit property</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  // Editing view: inline input with type selector and action buttons
  return (
    <div className="flex flex-col gap-2 p-2 -mx-2 bg-purple-50/50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 rounded">
      {/* Value input */}
      <div className="flex items-center gap-2">
        {valueType === PropertyValueType.Boolean || valueType === PropertyValueType.Logical ? (
          <div className="flex items-center gap-2 flex-1">
            <Switch
              checked={value === 'true'}
              onCheckedChange={(checked) => setValue(checked ? 'true' : 'false')}
            />
            <span className="text-xs text-zinc-500">{value === 'true' ? 'True' : 'False'}</span>
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
            placeholder="Enter value"
            type={valueType === PropertyValueType.Real || valueType === PropertyValueType.Integer ? 'number' : 'text'}
            step={valueType === PropertyValueType.Real ? 'any' : undefined}
          />
        )}

        {/* Action buttons */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 hover:bg-green-100 dark:hover:bg-green-900/30"
              onClick={handleSave}
            >
              <Check className="h-3.5 w-3.5 text-green-600" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{editScope && !showScopeConfirm && !isUnchanged ? 'Review scope (Enter)' : 'Save (Enter)'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 hover:bg-zinc-200 dark:hover:bg-zinc-700"
              onClick={handleCancel}
            >
              <X className="h-3.5 w-3.5 text-zinc-500" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Cancel (Esc)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 hover:bg-red-100 dark:hover:bg-red-900/30"
              onClick={handleDelete}
            >
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete property</TooltipContent>
        </Tooltip>
      </div>

      {/* Type selector - always visible */}
      <div className="flex flex-wrap gap-1">
        {[
          { type: PropertyValueType.String, label: 'String' },
          { type: PropertyValueType.Label, label: 'Label' },
          { type: PropertyValueType.Identifier, label: 'ID' },
          { type: PropertyValueType.Real, label: 'Real' },
          { type: PropertyValueType.Integer, label: 'Int' },
          { type: PropertyValueType.Boolean, label: 'Bool' },
        ].map(({ type, label }) => (
          <Button
            key={type}
            variant={valueType === type ? 'default' : 'outline'}
            size="sm"
            className="h-5 px-2 text-[10px]"
            onClick={() => {
              setValueType(type);
              if (showScopeConfirm) setShowScopeConfirm(false);
              // Convert value if switching to/from boolean
              if (type === PropertyValueType.Boolean || type === PropertyValueType.Logical) {
                const boolVal = value.toLowerCase() === 'true' || value === '1' || value === 'yes';
                setValue(boolVal ? 'true' : 'false');
              }
            }}
          >
            {label}
          </Button>
        ))}
      </div>

      {showScopeConfirm && editScope && (
        <div className="border border-indigo-200 dark:border-indigo-800/60 bg-white/75 dark:bg-zinc-950/60 px-2.5 py-2 text-[11px]">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">
            {editScope.mode === 'type'
              ? `Apply this change on ${editScope.typeEntityName}?`
              : `Write this inherited value back to ${editScope.typeEntityName}?`}
          </div>
          <div className="mt-0.5 text-zinc-600 dark:text-zinc-400">
            {editScope.affectedCount} {editScope.affectedCount === 1 ? 'occurrence' : 'occurrences'} may reflect the update unless locally overridden.
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-6 rounded-none border-indigo-300 text-[10px] uppercase tracking-wide hover:bg-indigo-50 dark:border-indigo-700 dark:hover:bg-indigo-950/30"
              onClick={commitSave}
            >
              Apply To Type
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 rounded-none px-2 text-[10px] uppercase tracking-wide"
              onClick={() => setShowScopeConfirm(false)}
            >
              Keep Editing
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
}

/**
 * Schema-aware dialog for adding new properties.
 * Filters available property sets based on IFC entity type.
 * Shows property suggestions with correct types from IFC4 standard.
 */
export function NewPropertyDialog({ modelId, entityId, entityType, existingPsets, schemaVersion }: NewPropertyDialogProps) {
  const setProperty = useViewerStore((s) => s.setProperty);
  const createPropertySet = useViewerStore((s) => s.createPropertySet);
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

    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    const parsedValue = parseValue(value, valueType);

    // Check if pset exists on entity already
    const psetExists = existingPsets.includes(effectivePsetName);

    if (!psetExists) {
      createPropertySet(normalizedModelId, entityId, effectivePsetName, [
        { name: effectivePropName, value: parsedValue, type: valueType },
      ]);
    } else {
      setProperty(normalizedModelId, entityId, effectivePsetName, effectivePropName, parsedValue, valueType);
    }

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
  }, [modelId, entityId, effectivePsetName, effectivePropName, value, valueType, existingPsets, setProperty, createPropertySet, bumpMutationVersion]);

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
        <Button variant="outline" size="sm" title="Property" className="panel-action-button h-7 min-w-0">
          <Plus className="h-3 w-3 shrink-0 panel-compact-icon" />
          <span className="panel-compact-text">Property</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            Add Property
          </DialogTitle>
          <DialogDescription>
            Add a property to this <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{entityType}</span> element.
            {validPsetDefs.length > 0 && (
              <span className="block mt-1 text-emerald-600 dark:text-emerald-400">
                {schemaVersion || 'IFC4'} schema: {validPsetDefs.length} standard property set{validPsetDefs.length !== 1 ? 's' : ''} available
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Property Set Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Property Set</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => { setIsCustomPset(!isCustomPset); setPsetName(''); setCustomPsetName(''); setPropName(''); setCustomPropName(''); }}
              >
                {isCustomPset ? 'Use standard' : 'Custom name'}
              </Button>
            </div>
            {isCustomPset ? (
              <Input
                value={customPsetName}
                onChange={(e) => setCustomPsetName(e.target.value)}
                placeholder="e.g., Pset_MyCustomProperties"
                className="font-mono text-sm"
              />
            ) : (
              <Select value={psetName} onValueChange={(v) => { setPsetName(v); setPropName(''); setCustomPropName(''); setValue(''); }}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue placeholder="Select property set..." />
                </SelectTrigger>
                <SelectContent>
                  {/* Existing psets on this entity */}
                  {existingStandardPsets.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                        On this element
                      </div>
                      {existingStandardPsets.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex items-center gap-2">
                            <span>{def.name}</span>
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">existing</Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                  {/* Non-standard existing psets */}
                  {existingPsets.filter(p => !existingStandardPsets.some(d => d.name === p)).length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                        Existing (custom)
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
                        {schemaVersion || 'IFC4'} Standard — {entityType}
                      </div>
                      {availableStandardPsets.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{def.name}</span>
                              <Badge variant="outline" className="h-4 px-1 text-[9px] border-emerald-300 text-emerald-600">new</Badge>
                            </div>
                            <span className="text-[10px] text-zinc-400">{def.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Property Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Property</Label>
            {propertySuggestions.length > 0 ? (
              <div className="space-y-2">
                <Select value={propName} onValueChange={handlePropertySelect}>
                  <SelectTrigger className="font-mono text-sm">
                    <SelectValue placeholder="Select property..." />
                  </SelectTrigger>
                  <SelectContent>
                    {propertySuggestions.map((prop) => (
                      <SelectItem key={prop.name} value={prop.name}>
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{prop.name}</span>
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">{getTypeName(prop.type)}</Badge>
                          </div>
                          <span className="text-[10px] text-zinc-400">{prop.description}</span>
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
                    placeholder="Or type custom property name..."
                    className="font-mono text-sm"
                  />
                )}
              </div>
            ) : (
              <Input
                value={customPropName}
                onChange={(e) => setCustomPropName(e.target.value)}
                placeholder="e.g., FireRating"
                className="font-mono text-sm"
              />
            )}
          </div>

          {/* Type selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Type</Label>
            <Select
              value={valueType.toString()}
              onValueChange={(v) => setValueType(parseInt(v) as PropertyValueType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PropertyValueType.String.toString()}>String</SelectItem>
                <SelectItem value={PropertyValueType.Real.toString()}>Real</SelectItem>
                <SelectItem value={PropertyValueType.Integer.toString()}>Integer</SelectItem>
                <SelectItem value={PropertyValueType.Boolean.toString()}>Boolean</SelectItem>
                <SelectItem value={PropertyValueType.Label.toString()}>Label</SelectItem>
                <SelectItem value={PropertyValueType.Identifier.toString()}>Identifier</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Value input */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Value</Label>
            {valueType === PropertyValueType.Boolean ? (
              <div className="flex items-center gap-3">
                <Switch
                  checked={value === 'true'}
                  onCheckedChange={(checked) => setValue(checked ? 'true' : 'false')}
                />
                <span className="text-sm text-zinc-500">{value === 'true' ? 'True' : 'False'}</span>
              </div>
            ) : (
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Property value"
                type={valueType === PropertyValueType.Real || valueType === PropertyValueType.Integer ? 'number' : 'text'}
                className="font-mono text-sm"
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!effectivePsetName || !effectivePropName}>
            Add Property
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

/**
 * Dialog for adding a classification reference to an entity.
 * Supports common classification systems (Uniclass, OmniClass, MasterFormat, etc.).
 * Stored as a special property set for mutation tracking.
 */
export function AddClassificationDialog({ modelId, entityId, entityType }: AddClassificationDialogProps) {
  const createPropertySet = useViewerStore((s) => s.createPropertySet);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [open, setOpen] = useState(false);
  const [system, setSystem] = useState('');
  const [customSystem, setCustomSystem] = useState('');
  const [identification, setIdentification] = useState('');
  const [name, setName] = useState('');

  const effectiveSystem = system === '__custom__' ? customSystem : system;

  const handleSubmit = useCallback(() => {
    if (!effectiveSystem || !identification) return;

    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    // Store classification as a property set named "Classification [SystemName]"
    const psetName = `Classification [${effectiveSystem}]`;
    createPropertySet(normalizedModelId, entityId, psetName, [
      { name: 'System', value: effectiveSystem, type: PropertyValueType.Label },
      { name: 'Identification', value: identification, type: PropertyValueType.Identifier },
      { name: 'Name', value: name || identification, type: PropertyValueType.Label },
    ]);

    bumpMutationVersion();

    // Reset form
    setSystem('');
    setCustomSystem('');
    setIdentification('');
    setName('');
    setOpen(false);
  }, [modelId, entityId, effectiveSystem, identification, name, createPropertySet, bumpMutationVersion]);

  return (
    <Dialog open={open} onOpenChange={(o) => {
      setOpen(o);
      if (!o) { setSystem(''); setCustomSystem(''); setIdentification(''); setName(''); }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" title="Classification" className="panel-action-button h-7 min-w-0">
          <Tag className="h-3 w-3 shrink-0 panel-compact-icon" />
          <span className="panel-compact-text">Classification</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-4 w-4" />
            Add Classification
          </DialogTitle>
          <DialogDescription>
            Assign a classification reference to this <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{entityType}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Classification System */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Classification System</Label>
            <Select value={system} onValueChange={setSystem}>
              <SelectTrigger>
                <SelectValue placeholder="Select system..." />
              </SelectTrigger>
              <SelectContent>
                {CLASSIFICATION_SYSTEMS.map((cs) => (
                  <SelectItem key={cs.name} value={cs.name}>
                    <div className="flex flex-col">
                      <span className="font-medium">{cs.name}</span>
                      <span className="text-[10px] text-zinc-400">{cs.description}</span>
                    </div>
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">
                  <span className="text-zinc-500">Custom system...</span>
                </SelectItem>
              </SelectContent>
            </Select>
            {system === '__custom__' && (
              <Input
                value={customSystem}
                onChange={(e) => setCustomSystem(e.target.value)}
                placeholder="Classification system name"
                className="mt-2"
              />
            )}
          </div>

          {/* Identification (code) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Identification Code</Label>
            <Input
              value={identification}
              onChange={(e) => setIdentification(e.target.value)}
              placeholder="e.g., Ss_25_10_30 or 03 30 00"
              className="font-mono"
            />
            <p className="text-[10px] text-zinc-400">The classification code or reference number</p>
          </div>

          {/* Name (optional) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Name (optional)</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Cast-in-place concrete walls"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!effectiveSystem || !identification}>
            Add Classification
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

/**
 * Dialog for assigning a material to an entity.
 * Stored as a special property set for mutation tracking.
 */
export function AddMaterialDialog({ modelId, entityId, entityType }: AddMaterialDialogProps) {
  const createPropertySet = useViewerStore((s) => s.createPropertySet);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  const [open, setOpen] = useState(false);
  const [materialName, setMaterialName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = useCallback(() => {
    if (!materialName) return;

    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    // Store material as a property set named "Material"
    const psetName = `Material [${materialName}]`;
    const properties: Array<{ name: string; value: string; type: PropertyValueType }> = [
      { name: 'Name', value: materialName, type: PropertyValueType.Label },
    ];

    if (category) {
      properties.push({ name: 'Category', value: category, type: PropertyValueType.Label });
    }
    if (description) {
      properties.push({ name: 'Description', value: description, type: PropertyValueType.Label });
    }

    createPropertySet(normalizedModelId, entityId, psetName, properties);
    bumpMutationVersion();

    // Reset form
    setMaterialName('');
    setCategory('');
    setDescription('');
    setOpen(false);
  }, [modelId, entityId, materialName, category, description, createPropertySet, bumpMutationVersion]);

  // Common material categories (module-level constant used below)
  const materialCategories = MATERIAL_CATEGORIES;

  return (
    <Dialog open={open} onOpenChange={(o) => {
      setOpen(o);
      if (!o) { setMaterialName(''); setCategory(''); setDescription(''); }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" title="Material" className="panel-action-button h-7 min-w-0">
          <Layers className="h-3 w-3 shrink-0 panel-compact-icon" />
          <span className="panel-compact-text">Material</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Add Material
          </DialogTitle>
          <DialogDescription>
            Assign a material to this <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{entityType}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Material Name */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Material Name</Label>
            <Input
              value={materialName}
              onChange={(e) => setMaterialName(e.target.value)}
              placeholder="e.g., Concrete C30/37"
              className="font-mono"
            />
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Select category..." />
              </SelectTrigger>
              <SelectContent>
                {materialCategories.map((cat) => (
                  <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Additional details about the material"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!materialName}>
            Add Material
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Common material categories - static, hoisted to module scope
const MATERIAL_CATEGORIES = [
  'Concrete', 'Steel', 'Wood', 'Masonry', 'Glass', 'Aluminium',
  'Insulation', 'Gypsum', 'Stone', 'Ceramic', 'Plastic', 'Composite',
] as const;

// ============================================================================
// Quantity Dialog
// ============================================================================

interface AddQuantityDialogProps {
  modelId: string;
  entityId: number;
  entityType: string;
  existingQtos: string[];
}

/**
 * Schema-aware dialog for adding quantities.
 * Filters available quantity sets based on IFC entity type.
 * Shows quantity suggestions with correct types from IFC4 standard.
 */
export function AddQuantityDialog({ modelId, entityId, entityType, existingQtos }: AddQuantityDialogProps) {
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

    let normalizedModelId = modelId;
    if (modelId === 'legacy') {
      normalizedModelId = '__legacy__';
    }

    const parsedValue = parseFloat(value) || 0;

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
  }, [modelId, entityId, effectiveQtoName, effectiveQuantityName, value, existingQtos, setProperty, createPropertySet, bumpMutationVersion]);

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
        <Button variant="outline" size="sm" title="Quantity" className="panel-action-button h-7 min-w-0">
          <Ruler className="h-3 w-3 shrink-0 panel-compact-icon" />
          <span className="panel-compact-text">Quantity</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ruler className="h-4 w-4" />
            Add Quantity
          </DialogTitle>
          <DialogDescription>
            Add a quantity to this <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{entityType}</span> element.
            {validQtoDefs.length > 0 && (
              <span className="block mt-1 text-emerald-600 dark:text-emerald-400">
                IFC4 schema: {validQtoDefs.length} standard quantity set{validQtoDefs.length !== 1 ? 's' : ''} available
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {/* Quantity Set Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Quantity Set</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => { setIsCustomQto(!isCustomQto); setQtoName(''); setCustomQtoName(''); setQuantityName(''); setCustomQuantityName(''); }}
              >
                {isCustomQto ? 'Use standard' : 'Custom name'}
              </Button>
            </div>
            {isCustomQto ? (
              <Input
                value={customQtoName}
                onChange={(e) => setCustomQtoName(e.target.value)}
                placeholder="e.g., Qto_MyCustomQuantities"
                className="font-mono text-sm"
              />
            ) : (
              <Select value={qtoName} onValueChange={(v) => { setQtoName(v); setQuantityName(''); setCustomQuantityName(''); setValue(''); }}>
                <SelectTrigger className="font-mono text-sm">
                  <SelectValue placeholder="Select quantity set..." />
                </SelectTrigger>
                <SelectContent>
                  {existingStandardQtos.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                        On this element
                      </div>
                      {existingStandardQtos.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex items-center gap-2">
                            <span>{def.name}</span>
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">existing</Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </>
                  )}
                  {existingQtos.filter(q => !existingStandardQtos.some(d => d.name === q)).length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                        Existing (custom)
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
                        IFC4 Standard — {entityType}
                      </div>
                      {availableStandardQtos.map((def) => (
                        <SelectItem key={def.name} value={def.name}>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{def.name}</span>
                              <Badge variant="outline" className="h-4 px-1 text-[9px] border-emerald-300 text-emerald-600">new</Badge>
                            </div>
                            <span className="text-[10px] text-zinc-400">{def.description}</span>
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
            <Label className="text-sm font-medium">Quantity</Label>
            {quantitySuggestions.length > 0 ? (
              <div className="space-y-2">
                <Select value={quantityName} onValueChange={handleQuantitySelect}>
                  <SelectTrigger className="font-mono text-sm">
                    <SelectValue placeholder="Select quantity..." />
                  </SelectTrigger>
                  <SelectContent>
                    {quantitySuggestions.map((qty) => (
                      <SelectItem key={qty.name} value={qty.name}>
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{qty.name}</span>
                            <Badge variant="secondary" className="h-4 px-1 text-[9px]">{qty.unit}</Badge>
                          </div>
                          <span className="text-[10px] text-zinc-400">{qty.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!quantityName && (
                  <Input
                    value={customQuantityName}
                    onChange={(e) => setCustomQuantityName(e.target.value)}
                    placeholder="Or type custom quantity name..."
                    className="font-mono text-sm"
                  />
                )}
              </div>
            ) : (
              <Input
                value={customQuantityName}
                onChange={(e) => setCustomQuantityName(e.target.value)}
                placeholder="e.g., Length"
                className="font-mono text-sm"
              />
            )}
          </div>

          {/* Value input */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Value
              {quantityName && (
                <span className="ml-2 text-xs text-zinc-400 font-normal">
                  ({getQuantityUnit(quantityType)})
                </span>
              )}
            </Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Numeric value"
              type="number"
              step="any"
              className="font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!effectiveQtoName || !effectiveQuantityName}>
            Add Quantity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
}

/**
 * Edit mode toolbar with dropdown for adding properties, classifications, materials, and quantities.
 * Schema-aware: filters available property/quantity sets based on entity type.
 */
export function EditToolbar({ modelId, entityId, entityType, existingPsets, existingQtos, schemaVersion }: EditToolbarProps) {
  return (
    <div className="panel-container flex items-center justify-between gap-2 mb-3 pb-2 border-b border-purple-200 dark:border-purple-800 bg-purple-50/30 dark:bg-purple-950/20 -mx-3 -mt-3 px-3 pt-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        <NewPropertyDialog
          modelId={modelId}
          entityId={entityId}
          entityType={entityType}
          existingPsets={existingPsets}
          schemaVersion={schemaVersion}
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
      <UndoRedoButtons modelId={modelId} />
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleUndo}
            disabled={!canUndo(normalizedModelId)}
          >
            <Undo className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Undo</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleRedo}
            disabled={!canRedo(normalizedModelId)}
          >
            <Redo className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Redo</TooltipContent>
      </Tooltip>
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

function formatDisplayValue(value: unknown): string {
  const raw = extractRawValue(value);
  if (raw === null || raw === undefined) return '\u2014';
  if (typeof raw === 'boolean') return raw ? 'True' : 'False';
  if (typeof raw === 'number') {
    return Number.isInteger(raw)
      ? raw.toLocaleString()
      : raw.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (Array.isArray(raw)) return JSON.stringify(raw);

  // Handle boolean strings (STEP enum format)
  const strVal = String(raw);
  const upper = strVal.toUpperCase();
  if (upper === '.T.') return 'True';
  if (upper === '.F.') return 'False';
  if (upper === '.U.') return 'Unknown';
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

function getTypeName(type: PropertyValueType): string {
  switch (type) {
    case PropertyValueType.String: return 'String';
    case PropertyValueType.Label: return 'Label';
    case PropertyValueType.Identifier: return 'Identifier';
    case PropertyValueType.Real: return 'Real';
    case PropertyValueType.Integer: return 'Integer';
    case PropertyValueType.Boolean: return 'Boolean';
    case PropertyValueType.Logical: return 'Logical';
    default: return 'String';
  }
}

function parseValue(value: string, type: PropertyValueType): PropertyValue {
  switch (type) {
    case PropertyValueType.Real:
      return parseFloat(value) || 0;
    case PropertyValueType.Integer:
      return parseInt(value, 10) || 0;
    case PropertyValueType.Boolean:
    case PropertyValueType.Logical:
      return value.toLowerCase() === 'true';
    default:
      return value;
  }
}
