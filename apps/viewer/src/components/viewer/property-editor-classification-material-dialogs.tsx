/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AddClassificationDialog` and `AddMaterialDialog`, extracted out of
 * `PropertyEditor.tsx` (#5812) so that file does not grow past its size
 * while their fields gain real labels — every field, including its
 * `Select`s, is wrapped in `Field` (see
 * `property-editor-new-property-dialog.tsx`'s header for how `Field` labels
 * a `Select` via `FieldContext` rather than by cloning props onto it).
 */

import { useState, useCallback } from 'react';
import { Tag, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { CLASSIFICATION_SYSTEMS } from '@/lib/ifc4-pset-definitions';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import { addClassificationAssociation, addMaterialAssociation } from '@/lib/authoring/associations';
import { hasActiveTranslation } from '@/i18n/registry';
import { MATERIAL_CATEGORIES } from './property-editor-options';
import { EDIT_TOOL_CLS } from './PropertyEditor';

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
            <Field label={t('propertyEditor.classification.system')}>
              <Select value={system} onValueChange={setSystem}>
                <SelectTrigger>
                  <SelectValue placeholder={t('propertyEditor.classification.selectSystem')} />
                </SelectTrigger>
                <SelectContent>
                  {CLASSIFICATION_SYSTEMS.map((cs) => (
                    <SelectItem key={cs.name} value={cs.name}>
                      <div className="flex flex-col">
                        <span className="font-medium">{cs.name}</span>
                        <span className="text-2xs text-zinc-400">{locale === 'en' || !hasActiveTranslation('propertyEditor.classification.standardSystemDescription') ? cs.description : t('propertyEditor.classification.standardSystemDescription', { name: cs.name })}</span>
                      </div>
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">
                    <span className="text-zinc-500">{t('propertyEditor.classification.customSystem')}</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {system === '__custom__' && (
              <Field label={t('propertyEditor.classification.system')} labelClassName="sr-only">
                <Input
                  value={customSystem}
                  onChange={(e) => setCustomSystem(e.target.value)}
                  placeholder={t('propertyEditor.classification.systemPlaceholder')}
                  className="mt-2"
                />
              </Field>
            )}
          </div>

          {/* Identification (code) */}
          <div className="space-y-2">
            <Field label={t('propertyEditor.classification.code')} hint={t('propertyEditor.classification.codeHelp')}>
              <Input
                value={identification}
                onChange={(e) => setIdentification(e.target.value)}
                placeholder={t('propertyEditor.classification.codePlaceholder')}
                className="font-mono"
              />
            </Field>
          </div>

          {/* Name (optional) */}
          <Field label={t('propertyEditor.classification.name')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('propertyEditor.classification.namePlaceholder')}
            />
          </Field>
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
          <Field label={t('propertyEditor.material.name')}>
            <Input
              value={materialName}
              onChange={(e) => setMaterialName(e.target.value)}
              placeholder={t('propertyEditor.material.namePlaceholder')}
              className="font-mono"
            />
          </Field>

          {/* Category */}
          <Field label={t('propertyEditor.material.category')}>
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
          </Field>

          {/* Description */}
          <Field label={t('propertyEditor.material.descriptionLabel')}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('propertyEditor.material.descriptionPlaceholder')}
            />
          </Field>
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
