/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property Editor component for editing IFC property values inline.
 * Includes schema-aware property addition with IFC4 standard validation.
 *
 * The schema-aware "add" dialogs (#5812: labelling every field with `Field`/
 * `aria-label`) live in sibling files so this one does not grow past its
 * size — `property-editor-new-property-dialog.tsx`,
 * `property-editor-quantity-dialog.tsx`,
 * `property-editor-classification-material-dialogs.tsx`, and
 * `property-editor-reassign-dialog.tsx` — and are re-exported below so
 * `import { NewPropertyDialog, ... } from './PropertyEditor'` still resolves
 * for existing call sites and tests.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Trash2, PenLine, Undo, Redo, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { resolveReassignSchema, isReassignableElement } from '@/lib/ifc-class-reassign';
import { useViewerStore } from '@/store';
import { PropertyValueType } from '@ifc-lite/data';
import type { PropertyValue } from '@ifc-lite/mutations';
import { useTranslation, type TranslationKey } from '@/i18n';
import { INLINE_VALUE_TYPES } from './property-editor-options';
import type { InheritedSets } from '@/lib/properties/add-to-property-set';

import { NewPropertyDialog } from './property-editor-new-property-dialog';
import { AddQuantityDialog } from './property-editor-quantity-dialog';
import { AddClassificationDialog, AddMaterialDialog } from './property-editor-classification-material-dialogs';
import { ReassignClassDialog, ReassignBadge } from './property-editor-reassign-dialog';
// Re-exported so `import { NewPropertyDialog, ... } from './PropertyEditor'` still resolves.
export { NewPropertyDialog, AddQuantityDialog, AddClassificationDialog, AddMaterialDialog, ReassignClassDialog, ReassignBadge };

// ── Edit-deck button styling ────────────────────────────────────────────────
// Data-enrichment actions (Property / Quantity / Classification / Material)
// live as quiet icon keys inside one segmented control — discoverable via
// tooltip, compact enough to leave room for the headline action. Exported:
// the four dialog files above render this same trigger style.
export const EDIT_TOOL_CLS =
  'h-7 w-8 rounded-none border-0 bg-transparent text-zinc-500 shadow-none transition-colors hover:bg-indigo-500/10 hover:text-indigo-600 focus-visible:bg-indigo-500/10 dark:text-zinc-400 dark:hover:bg-indigo-400/15 dark:hover:text-indigo-300';

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
          aria-label={`${propName}: ${displayValue}`}
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
            aria-label={propName}
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

export function getTypeNameKey(type: PropertyValueType): TranslationKey {
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
