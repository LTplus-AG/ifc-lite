/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DrawingSettingsPanel - Full control over 2D drawing graphic styles
 *
 * Provides:
 * - Preset selection dropdown
 * - Custom rule editor
 * - Color, line weight, hatch controls
 */

import React, { useCallback, useState, useMemo } from 'react';
import { Palette, Plus, Trash2, ChevronDown, ChevronRight, GripVertical, Eye, EyeOff, Check, Copy, PenTool, Flame, Building2, Wrench, Printer, type LucideIcon } from 'lucide-react';
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { GraphicOverrideRule, GraphicStyle } from '@ifc-lite/drawing-2d';

// Common IFC types for the dropdown
const COMMON_IFC_TYPES = [
  'IfcWall',
  'IfcWallStandardCase',
  'IfcSlab',
  'IfcColumn',
  'IfcBeam',
  'IfcDoor',
  'IfcWindow',
  'IfcStair',
  'IfcRoof',
  'IfcRailing',
  'IfcCovering',
  'IfcFurnishingElement',
  'IfcSpace',
  'IfcBuildingElementProxy',
];

// Line weight presets
const LINE_WEIGHTS = [
  { value: 'heavy', label: 'Heavy (0.5mm)' },
  { value: 'medium', label: 'Medium (0.35mm)' },
  { value: 'light', label: 'Light (0.25mm)' },
  { value: 'hairline', label: 'Hairline (0.18mm)' },
];

// Icon mapping for presets
const PRESET_ICONS: Record<string, LucideIcon> = {
  Palette,
  PenTool,
  Flame,
  Building2,
  Wrench,
  Printer,
};

function PresetIcon({ iconName, className }: { iconName?: string; className?: string }) {
  const Icon = iconName ? PRESET_ICONS[iconName] : Palette;
  if (!Icon) return <Palette className={className} />;
  return <Icon className={className} />;
}

export function DrawingSettingsPanel() {
  const { t } = useTranslation(); const graphicOverridePresets = useViewerStore((s) => s.graphicOverridePresets);
  const activePresetId = useViewerStore((s) => s.activePresetId);
  const setActivePreset = useViewerStore((s) => s.setActivePreset);
  const customOverrideRules = useViewerStore((s) => s.customOverrideRules);
  const addCustomRule = useViewerStore((s) => s.addCustomRule);
  const updateCustomRule = useViewerStore((s) => s.updateCustomRule);
  const removeCustomRule = useViewerStore((s) => s.removeCustomRule);
  const overridesEnabled = useViewerStore((s) => s.overridesEnabled);
  const toggleOverridesEnabled = useViewerStore((s) => s.toggleOverridesEnabled);

  // Expanded sections
  const [presetsOpen, setPresetsOpen] = useState(true);
  const [customRulesOpen, setCustomRulesOpen] = useState(true);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);

  // Get the active preset's rules for display
  const activePreset = useMemo(() => {
    if (!activePresetId) return null;
    return graphicOverridePresets.find((p) => p.id === activePresetId) ?? null;
  }, [activePresetId, graphicOverridePresets]);

  // Add new custom rule
  const handleAddRule = useCallback(() => {
    const newRule: GraphicOverrideRule = {
      id: `custom-${Date.now()}`,
      name: 'New Rule',
      enabled: true,
      priority: customOverrideRules.length + 100, // Start after presets
      criteria: {
        type: 'ifcType',
        ifcTypes: ['IfcWall'],
        includeSubtypes: true,
      },
      style: {
        fillColor: '#808080',
        strokeColor: '#000000',
      },
    };
    addCustomRule(newRule);
    setEditingRuleId(newRule.id);
  }, [customOverrideRules.length, addCustomRule]);

  // Copy preset rules to custom rules for editing
  const handleCopyPresetToCustom = useCallback(() => {
    if (!activePreset) return;

    // Copy each rule from preset to custom with new IDs
    for (const rule of activePreset.rules) {
      const newRule: GraphicOverrideRule = {
        ...rule,
        id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        priority: customOverrideRules.length + 100,
      };
      addCustomRule(newRule);
    }

    // Clear preset selection and expand custom rules
    setActivePreset(null);
    setCustomRulesOpen(true);
  }, [activePreset, customOverrideRules.length, addCustomRule, setActivePreset]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* The inspector tab (#5495) carries the title; this row keeps only the
          functional enable/disable toggle, not a redundant close button. */}
      <div className="flex items-center justify-end px-4 py-2 border-b bg-muted/50">
        <Button
          variant={overridesEnabled ? 'default' : 'outline'}
          size="sm"
          onClick={toggleOverridesEnabled}
          className="h-7 text-xs"
        >
          {t(overridesEnabled ? 'drawingUnderlay.settings.overridesEnabled' : 'drawingUnderlay.settings.overridesDisabled')}
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Presets Section */}
        <Collapsible open={presetsOpen} onOpenChange={setPresetsOpen}>
          <CollapsibleTrigger asChild>
            <button className="w-full flex items-center justify-between px-4 py-2 hover:bg-muted/50 transition-colors">
              <span className="text-sm font-medium">{t('drawingUnderlay.settings.presetsHeading')}</span>
              {presetsOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-4 pb-3 space-y-1">
              {/* Built-in presets */}
              {graphicOverridePresets.map((preset) => (
                <button
                  key={preset.id}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-sm ${
                    activePresetId === preset.id
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-muted text-foreground'
                  }`}
                  onClick={() => setActivePreset(preset.id)}
                >
                  <div className={`w-6 h-6 rounded flex items-center justify-center ${activePresetId === preset.id ? 'bg-primary/20' : 'bg-muted'}`}>
                    <PresetIcon iconName={preset.icon} className="h-3.5 w-3.5" />
                  </div>
                  <span className="flex-1 text-left font-medium">{preset.name}</span>
                  {activePresetId === preset.id && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Active Preset Rules (read-only with edit option) */}
        {activePreset && activePreset.rules.length > 0 && (
          <div className="border-t">
            <div className="px-4 py-2 flex items-center justify-between">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('drawingUnderlay.settings.activePresetRulesHeading', { name: activePreset.name })}</h3>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={handleCopyPresetToCustom}
                title={t('drawingUnderlay.settings.copyToCustomTitle')}
              >
                <Copy className="h-3 w-3 mr-1" />
                {t('drawingUnderlay.settings.editAsCustomButton')}
              </Button>
            </div>
            <div className="px-4 pb-4 space-y-1">
              {activePreset.rules.map((rule) => (
                <PresetRuleItem key={rule.id} rule={rule} />
              ))}
            </div>
          </div>
        )}

        {/* Custom Rules Section */}
        <Collapsible open={customRulesOpen} onOpenChange={setCustomRulesOpen}>
          <div className="border-t">
            <CollapsibleTrigger asChild>
              <button className="w-full flex items-center justify-between px-4 py-2 hover:bg-muted/50 transition-colors">
                <span className="text-sm font-medium">{t('drawingUnderlay.settings.customRulesHeading')}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('drawingUnderlay.settings.customRulesCount', { count: customOverrideRules.length })}
                  </span>
                  {customRulesOpen ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-4 space-y-2">
                {customOverrideRules.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground text-sm">
                    {t('drawingUnderlay.settings.noCustomRules')}
                  </div>
                ) : (
                  customOverrideRules.map((rule) => (
                    <CustomRuleItem
                      key={rule.id}
                      rule={rule}
                      isEditing={editingRuleId === rule.id}
                      onEdit={() => setEditingRuleId(rule.id)}
                      onSave={() => setEditingRuleId(null)}
                      onUpdate={(updates) => updateCustomRule(rule.id, updates)}
                      onRemove={() => removeCustomRule(rule.id)}
                    />
                  ))
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleAddRule}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {t('drawingUnderlay.settings.addCustomRuleButton')}
                </Button>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>
    </div>
  );
}

// Read-only preset rule display
function PresetRuleItem({ rule }: { rule: GraphicOverrideRule }) {
  // Extract IFC types from criteria
  const ifcTypes = useMemo(() => {
    if ('ifcTypes' in rule.criteria && rule.criteria.ifcTypes) {
      return rule.criteria.ifcTypes.join(', ');
    }
    if ('conditions' in rule.criteria) {
      // Find ifcType criteria in conditions
      for (const condition of rule.criteria.conditions) {
        if ('ifcTypes' in condition && condition.ifcTypes) {
          return condition.ifcTypes.join(', ');
        }
      }
    }
    return 'All';
  }, [rule.criteria]);

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 bg-muted/30 rounded text-xs">
      {rule.style.fillColor && (
        <div
          className="w-4 h-4 rounded border border-black/20"
          style={{ backgroundColor: rule.style.fillColor }}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{rule.name}</div>
        <div className="text-muted-foreground truncate">{ifcTypes}</div>
      </div>
    </div>
  );
}

// Editable custom rule
interface CustomRuleItemProps {
  rule: GraphicOverrideRule;
  isEditing: boolean;
  onEdit: () => void;
  onSave: () => void;
  onUpdate: (updates: Partial<GraphicOverrideRule>) => void;
  onRemove: () => void;
}

function CustomRuleItem({
  rule,
  isEditing,
  onEdit,
  onSave,
  onUpdate,
  onRemove,
}: CustomRuleItemProps) {
  const { t } = useTranslation(); // Extract IFC types
  const ifcTypes = useMemo(() => {
    if ('ifcTypes' in rule.criteria && rule.criteria.ifcTypes) {
      return rule.criteria.ifcTypes;
    }
    return [];
  }, [rule.criteria]);

  const handleIfcTypeChange = useCallback(
    (type: string) => {
      onUpdate({
        criteria: {
          type: 'ifcType',
          ifcTypes: [type],
          includeSubtypes: true,
        },
      });
    },
    [onUpdate]
  );

  const handleStyleChange = useCallback(
    (key: keyof GraphicStyle, value: string | number | undefined) => {
      onUpdate({
        style: {
          ...rule.style,
          [key]: value,
        },
      });
    },
    [rule.style, onUpdate]
  );

  if (!isEditing) {
    return (
      <div
        className="group flex items-center gap-2 px-2 py-1.5 bg-muted/30 rounded text-xs hover:bg-muted/50"
      >
        <button type="button" className="flex flex-1 min-w-0 items-center gap-2 text-left" onClick={onEdit}>
          <GripVertical className="h-3 w-3 text-muted-foreground" />
          {rule.style.fillColor && (
            <span className="w-4 h-4 rounded border border-black/20" style={{ backgroundColor: rule.style.fillColor }} />
          )}
          <span className="flex-1 min-w-0">
            <span className="block font-medium truncate">{rule.name}</span>
            <span className="block text-muted-foreground truncate">
              {ifcTypes.join(', ') || t('drawingUnderlay.settings.clickToEditPlaceholder')}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6 opacity-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onUpdate({ enabled: !rule.enabled });
          }}
        >
          {rule.enabled ? (
            <Eye className="h-3 w-3" />
          ) : (
            <EyeOff className="h-3 w-3 text-muted-foreground" />
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="p-3 bg-muted/30 rounded-lg border space-y-3">
      {/* Name */}
      <div>
        <Label className="text-xs">{t('drawingUnderlay.settings.ruleNameLabel')}</Label>
        <Input
          value={rule.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="h-8 text-sm mt-1"
        />
      </div>

      {/* IFC Class */}
      <div>
        <Label className="text-xs">{t('drawingUnderlay.settings.ifcClassLabel')}</Label>
        <Select
          value={ifcTypes[0] || ''}
          onValueChange={handleIfcTypeChange}
        >
          <SelectTrigger className="h-8 text-sm mt-1">
            <SelectValue placeholder={t('drawingUnderlay.settings.selectClassPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {COMMON_IFC_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Colors */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">{t('drawingUnderlay.settings.fillColorLabel')}</Label>
          <div className="flex gap-1 mt-1">
            <input
              type="color"
              value={rule.style.fillColor || '#808080'}
              onChange={(e) => handleStyleChange('fillColor', e.target.value)}
              className="w-8 h-8 rounded border cursor-pointer"
            />
            <Input
              value={rule.style.fillColor || '#808080'}
              onChange={(e) => handleStyleChange('fillColor', e.target.value)}
              className="h-8 text-xs font-mono flex-1"
            />
          </div>
        </div>
        <div>
          <Label className="text-xs">{t('drawingUnderlay.settings.strokeColorLabel')}</Label>
          <div className="flex gap-1 mt-1">
            <input
              type="color"
              value={rule.style.strokeColor || '#000000'}
              onChange={(e) => handleStyleChange('strokeColor', e.target.value)}
              className="w-8 h-8 rounded border cursor-pointer"
            />
            <Input
              value={rule.style.strokeColor || '#000000'}
              onChange={(e) => handleStyleChange('strokeColor', e.target.value)}
              className="h-8 text-xs font-mono flex-1"
            />
          </div>
        </div>
      </div>

      {/* Line Weight - preset or custom mm value */}
      <div>
        <Label className="text-xs">{t('drawingUnderlay.settings.lineWeightLabel')}</Label>
        <div className="flex gap-2 mt-1">
          <Select
            value={typeof rule.style.lineWeight === 'string' ? rule.style.lineWeight : 'custom'}
            onValueChange={(v) => {
              if (v === 'custom') {
                handleStyleChange('lineWeight', 0.35); // Default to 0.35mm
              } else {
                handleStyleChange('lineWeight', v);
              }
            }}
          >
            <SelectTrigger className="h-8 text-sm flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINE_WEIGHTS.map((w) => (
                <SelectItem key={w.value} value={w.value}>
                  {w.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">{t('drawingUnderlay.settings.customLineWeightOption')}</SelectItem>
            </SelectContent>
          </Select>
          {typeof rule.style.lineWeight === 'number' && (
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0.05}
                max={2}
                step={0.05}
                value={rule.style.lineWeight}
                onChange={(e) => handleStyleChange('lineWeight', parseFloat(e.target.value) || 0.35)}
                className="h-8 w-16 text-xs"
              />
              <span className="text-xs text-muted-foreground">{t('drawingUnderlay.settings.millimetersUnit')}</span>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4 mr-1" />
          {t('drawingUnderlay.settings.deleteButton')}
        </Button>
        <Button size="sm" onClick={onSave}>
          {t('drawingUnderlay.settings.doneButton')}
        </Button>
      </div>
    </div>
  );
}
