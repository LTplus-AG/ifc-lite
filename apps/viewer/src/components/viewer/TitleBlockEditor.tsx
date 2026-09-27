/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TitleBlockEditor - Modal dialog for editing title block fields
 *
 * Allows users to:
 * - Edit field values (project name, drawing number, etc.)
 * - Add/remove custom fields
 * - Configure field properties (label, auto-populate)
 * - Add revision entries
 */

import React, { useCallback, useState, useMemo } from 'react';
import { Plus, Trash2, Upload, Calendar, Hash, FileText, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TitleBlockField, RevisionEntry } from '@ifc-lite/drawing-2d';

interface TitleBlockEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Icon mapping for common field types
const FIELD_ICONS: Record<string, React.ReactNode> = {
  'project-name': <FileText className="h-4 w-4" />,
  'drawing-title': <FileText className="h-4 w-4" />,
  'drawing-number': <Hash className="h-4 w-4" />,
  revision: <Hash className="h-4 w-4" />,
  scale: <Hash className="h-4 w-4" />,
  date: <Calendar className="h-4 w-4" />,
  'drawn-by': <User className="h-4 w-4" />,
  'checked-by': <User className="h-4 w-4" />,
  'sheet-number': <Hash className="h-4 w-4" />,
};

// Standard field IDs
const STANDARD_FIELD_IDS = [
  'project-name',
  'drawing-title',
  'drawing-number',
  'revision',
  'scale',
  'date',
  'drawn-by',
  'checked-by',
  'sheet-number',
];

export function TitleBlockEditor({ open, onOpenChange }: TitleBlockEditorProps): React.ReactElement {
  const { t } = useTranslation();
  const activeSheet = useViewerStore((s) => s.activeSheet);
  const updateTitleBlockField = useViewerStore((s) => s.updateTitleBlockField);
  const addTitleBlockField = useViewerStore((s) => s.addTitleBlockField);
  const removeTitleBlockField = useViewerStore((s) => s.removeTitleBlockField);
  const setTitleBlockLogo = useViewerStore((s) => s.setTitleBlockLogo);
  const addRevision = useViewerStore((s) => s.addRevision);
  const removeRevision = useViewerStore((s) => s.removeRevision);

  // Local state for new field form
  const [newFieldLabel, setNewFieldLabel] = useState('');
  const [showNewFieldForm, setShowNewFieldForm] = useState(false);

  // Local state for new revision form
  const [newRevision, setNewRevision] = useState({
    revision: '',
    date: new Date().toLocaleDateString(),
    description: '',
    author: '',
  });
  const [showRevisionForm, setShowRevisionForm] = useState(false);

  // Group fields by category
  const fieldGroups = useMemo(() => {
    if (!activeSheet) return { standard: [], custom: [] };

    const standard: TitleBlockField[] = [];
    const custom: TitleBlockField[] = [];

    for (const field of activeSheet.titleBlock.fields) {
      if (STANDARD_FIELD_IDS.includes(field.id)) {
        standard.push(field);
      } else {
        custom.push(field);
      }
    }

    return { standard, custom };
  }, [activeSheet]);

  // Handle field value change
  const handleFieldChange = useCallback((fieldId: string, value: string) => {
    updateTitleBlockField(fieldId, value);
  }, [updateTitleBlockField]);

  // Add new custom field
  const handleAddField = useCallback(() => {
    if (!newFieldLabel.trim()) return;

    // Find max row from existing fields
    const maxRow = activeSheet?.titleBlock.fields.reduce(
      (max, f) => Math.max(max, f.row ?? 0),
      0
    ) ?? 0;

    const newField: TitleBlockField = {
      id: `custom-${Date.now()}`,
      label: newFieldLabel.trim(),
      value: '',
      editable: true,
      autoPopulate: false,
      fontSize: 3,
      fontWeight: 'normal',
      row: maxRow + 1,
      col: 0,
      colSpan: 2,
    };

    addTitleBlockField(newField);
    setNewFieldLabel('');
    setShowNewFieldForm(false);
  }, [newFieldLabel, activeSheet, addTitleBlockField]);

  // Handle logo upload
  const handleLogoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setTitleBlockLogo({
        source: dataUrl,
        widthMm: 30,
        heightMm: 15,
        position: 'top-left',
      });
    };
    reader.readAsDataURL(file);
  }, [setTitleBlockLogo]);

  // Add revision entry
  const handleAddRevision = useCallback(() => {
    if (!newRevision.revision || !newRevision.description) return;

    addRevision({
      revision: newRevision.revision,
      date: newRevision.date || new Date().toLocaleDateString(),
      description: newRevision.description,
      author: newRevision.author,
    });

    setNewRevision({
      revision: '',
      date: new Date().toLocaleDateString(),
      description: '',
      author: '',
    });
    setShowRevisionForm(false);
  }, [newRevision, addRevision]);

  if (!activeSheet) return <></>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('sheetsPdf.titleBlock.dialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Standard Fields */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              {t('sheetsPdf.titleBlock.standardFieldsHeading')}
            </h3>
            <div className="grid gap-3">
              {fieldGroups.standard.map((field) => (
                <div key={field.id} className="grid grid-cols-[120px_1fr] items-center gap-3">
                  <div className="flex items-center gap-2 text-sm">
                    {FIELD_ICONS[field.id] || <FileText className="h-4 w-4" />}
                    <span className="truncate">{field.label}</span>
                  </div>
                  <Input
                    value={field.value}
                    onChange={(e) => handleFieldChange(field.id, e.target.value)}
                    placeholder={t('sheetsPdf.titleBlock.fieldPlaceholder', { label: field.label.toLowerCase() })}
                    className="h-8"
                    disabled={!field.editable}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Custom Fields */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {t('sheetsPdf.titleBlock.customFieldsHeading')}
              </h3>
              <Button variant="outline" size="sm" onClick={() => setShowNewFieldForm(true)}>
                <Plus className="h-4 w-4 mr-1" />
                {t('sheetsPdf.titleBlock.addFieldButton')}
              </Button>
            </div>

            {showNewFieldForm && (
              <div className="flex gap-2 p-3 bg-muted/30 rounded-lg">
                <Input
                  value={newFieldLabel}
                  onChange={(e) => setNewFieldLabel(e.target.value)}
                  placeholder={t('sheetsPdf.titleBlock.fieldLabelPlaceholder')}
                  className="h-8 flex-1"
                  autoFocus
                />
                <Button size="sm" onClick={handleAddField} disabled={!newFieldLabel.trim()}>
                  {t('sheetsPdf.titleBlock.addButton')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowNewFieldForm(false);
                    setNewFieldLabel('');
                  }}
                >
                  {t('sheetsPdf.titleBlock.cancel')}
                </Button>
              </div>
            )}

            {fieldGroups.custom.length === 0 && !showNewFieldForm ? (
              <div className="text-sm text-muted-foreground text-center py-4">
                {t('sheetsPdf.titleBlock.noCustomFields')}
              </div>
            ) : (
              <div className="grid gap-2">
                {fieldGroups.custom.map((field) => (
                  <div key={field.id} className="flex items-center gap-2">
                    <div className="grid grid-cols-[120px_1fr] items-center gap-3 flex-1">
                      <span className="text-sm truncate">{field.label}</span>
                      <Input
                        value={field.value}
                        onChange={(e) => handleFieldChange(field.id, e.target.value)}
                        placeholder={t('sheetsPdf.titleBlock.fieldPlaceholder', { label: field.label.toLowerCase() })}
                        className="h-8"
                      />
                    </div>
                    <IconButton
                      label={t('sheetsPdf.titleBlock.removeFieldLabel', { label: field.label })}
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => removeTitleBlockField(field.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Logo */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              {t('sheetsPdf.titleBlock.companyLogoHeading')}
            </h3>
            <div className="flex items-center gap-4">
              {activeSheet.titleBlock.logo ? (
                <div className="flex items-center gap-3">
                  <div className="w-16 h-10 bg-muted rounded flex items-center justify-center overflow-hidden">
                    <img
                      src={activeSheet.titleBlock.logo.source}
                      alt={t('sheetsPdf.titleBlock.logoAlt')}
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTitleBlockLogo(null)}
                  >
                    {t('sheetsPdf.titleBlock.removeLogo')}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleLogoUpload}
                    />
                    <div className="flex items-center gap-2 px-3 py-2 border rounded-md text-sm hover:bg-muted/50 transition-colors">
                      <Upload className="h-4 w-4" />
                      {t('sheetsPdf.titleBlock.uploadLogo')}
                    </div>
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {t('sheetsPdf.titleBlock.logoFormats')}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Revisions */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                {t('sheetsPdf.titleBlock.revisionHistoryHeading')}
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRevisionForm(true)}
              >
                <Plus className="h-4 w-4 mr-1" />
                {t('sheetsPdf.titleBlock.addRevisionButton')}
              </Button>
            </div>

            {showRevisionForm && (
              <div className="p-3 bg-muted/30 rounded-lg space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">{t('sheetsPdf.titleBlock.revisionNumberLabel')}</Label>
                    <Input
                      value={newRevision.revision}
                      onChange={(e) => setNewRevision(prev => ({ ...prev, revision: e.target.value }))}
                      placeholder={t('sheetsPdf.titleBlock.revisionNumberPlaceholder')}
                      className="h-8 mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t('sheetsPdf.titleBlock.dateLabel')}</Label>
                    <Input
                      value={newRevision.date}
                      onChange={(e) => setNewRevision(prev => ({ ...prev, date: e.target.value }))}
                      placeholder={t('sheetsPdf.titleBlock.datePlaceholder')}
                      className="h-8 mt-1"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">{t('sheetsPdf.titleBlock.descriptionLabel')}</Label>
                  <Input
                    value={newRevision.description}
                    onChange={(e) => setNewRevision(prev => ({ ...prev, description: e.target.value }))}
                    placeholder={t('sheetsPdf.titleBlock.descriptionPlaceholder')}
                    className="h-8 mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">{t('sheetsPdf.titleBlock.authorLabel')}</Label>
                  <Input
                    value={newRevision.author}
                    onChange={(e) => setNewRevision(prev => ({ ...prev, author: e.target.value }))}
                    placeholder={t('sheetsPdf.titleBlock.authorPlaceholder')}
                    className="h-8 mt-1"
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  <Button size="sm" onClick={handleAddRevision} disabled={!newRevision.revision || !newRevision.description}>
                    {t('sheetsPdf.titleBlock.addRevisionButton')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowRevisionForm(false);
                      setNewRevision({ revision: '', date: new Date().toLocaleDateString(), description: '', author: '' });
                    }}
                  >
                    {t('sheetsPdf.titleBlock.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {activeSheet.revisions.length === 0 && !showRevisionForm ? (
              <div className="text-sm text-muted-foreground text-center py-4">
                {t('sheetsPdf.titleBlock.noRevisions')}
              </div>
            ) : (
              <div className="space-y-1">
                {activeSheet.revisions.map((rev, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between px-3 py-2 bg-muted/30 rounded text-xs"
                  >
                    <div className="flex gap-4">
                      <span className="font-mono font-bold">{rev.revision}</span>
                      <span className="text-muted-foreground">{rev.date}</span>
                      <span className="truncate">{rev.description}</span>
                      {rev.author && <span className="text-muted-foreground">{t('sheetsPdf.titleBlock.byAuthor', { author: rev.author })}</span>}
                    </div>
                    <IconButton
                      label={t('sheetsPdf.titleBlock.removeRevisionLabel', { revision: rev.revision })}
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => removeRevision(index)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('sheetsPdf.titleBlock.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
