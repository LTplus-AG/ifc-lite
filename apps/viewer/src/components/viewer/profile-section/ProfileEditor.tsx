/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cross-section editor of the Beam, Column and Member commands' Section
 * picker and of the Model inspector's Profile section (charter #6232, D2):
 * the kinds, the dimensions the picked kind needs, and a preview. It is a
 * controlled view: the caller decides what a pick and an edited dimension
 * write (the defaults of the next element, or one placed element), so the
 * command and the inspector look and behave the same.
 */

import { useId } from 'react';
import { profileSectionExtent, type ProfileSection, type ProfileSectionType } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { PROFILE_KINDS, PROFILE_KIND_LABEL } from '@/lib/profile-section/profile-kinds';
import { CommitField, InspectorRow } from '../model-inspector/InspectorControls';
import { METRE_SYMBOL, parseMetres } from '../model-inspector/inspector-fields';
import { SectionPreview } from './SectionPreview';

export interface ProfileEditorField {
  readonly id: string;
  readonly label: string;
  /** Metres. */
  readonly value: number;
}

interface ProfileEditorProps {
  type: ProfileSectionType;
  onType: (next: ProfileSectionType) => void;
  /** What the preview draws: the section as it would be written. */
  section: ProfileSection;
  /** The dimensions to edit; empty when they are edited elsewhere. */
  fields: readonly ProfileEditorField[];
  /** Commit one dimension in metres; false refuses it (the field reverts). */
  onField: (id: string, metres: number) => boolean;
  /** Why the section as shown cannot be written, when it cannot. */
  problem?: string | null;
  disabled?: boolean;
  className?: string;
}

/** Metres to a tenth of a millimetre, at least two decimals: a 5.6 mm web must not read as 6 mm. */
function formatSectionMetres(value: number): string {
  if (!Number.isFinite(value)) return '';
  const decimals = value.toFixed(4).replace(/0+$/, '').split('.')[1]?.length ?? 0;
  return value.toFixed(Math.max(2, decimals));
}

/** The kind buttons' pictograms: chunky versions of each shape, so they read at 22 px. */
const ICONS: Readonly<Record<ProfileSectionType, ProfileSection>> = {
  Rectangle: { Type: 'Rectangle', XDim: 0.7, YDim: 1 },
  I: { Type: 'I', OverallWidth: 0.8, OverallDepth: 1, WebThickness: 0.2, FlangeThickness: 0.2 },
  L: { Type: 'L', Depth: 1, Width: 1, Thickness: 0.25 },
  T: { Type: 'T', Depth: 1, FlangeWidth: 1, WebThickness: 0.25, FlangeThickness: 0.25 },
  U: { Type: 'U', Depth: 1, FlangeWidth: 0.8, WebThickness: 0.25, FlangeThickness: 0.25 },
  C: { Type: 'C', Depth: 1, Width: 0.8, WallThickness: 0.18, Girth: 0.3 },
  Circle: { Type: 'Circle', Radius: 0.5 },
  RectangleHollow: { Type: 'RectangleHollow', XDim: 0.9, YDim: 0.9, WallThickness: 0.2 },
  CircleHollow: { Type: 'CircleHollow', Radius: 0.5, WallThickness: 0.18 },
};
const icon = (type: ProfileSectionType): ProfileSection => ICONS[type];

function FieldRow({ field, onField }: { field: ProfileEditorField; onField: ProfileEditorProps['onField'] }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <InspectorRow label={field.label} htmlFor={id}>
      <CommitField
        id={id}
        value={formatSectionMetres(field.value)}
        onCommit={(text) => {
          const metres = parseMetres(text);
          return metres === null ? false : onField(field.id, metres);
        }}
        suffix={METRE_SYMBOL}
        ariaLabel={t('profileSection.fieldAria', { label: field.label })}
      />
    </InspectorRow>
  );
}

export function ProfileEditor({ type, onType, section, fields, onField, problem, disabled, className }: ProfileEditorProps) {
  const { t } = useTranslation();
  const [across, up] = profileSectionExtent(section);
  return (
    <div data-profile-editor data-profile-kind={type} className={cn('space-y-2', className)}>
      <fieldset className="m-0 grid min-w-0 grid-cols-5 gap-1 border-0 p-0">
        <legend className="sr-only">{t('profileSection.kindAria')}</legend>
        {PROFILE_KINDS.map((kind) => {
          const active = kind === type;
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={active}
              aria-label={t(PROFILE_KIND_LABEL[kind])}
              title={t(PROFILE_KIND_LABEL[kind])}
              disabled={disabled}
              data-profile-kind-button={kind}
              onClick={() => { if (!active) onType(kind); }}
              className={cn(
                'flex h-8 items-center justify-center rounded-sm border text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                active ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <SectionPreview section={icon(kind)} size={22} />
            </button>
          );
        })}
      </fieldset>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="space-y-1.5">
          {fields.map((field) => <FieldRow key={`${type}:${field.id}`} field={field} onField={onField} />)}
        </div>
        <SectionPreview
          section={section}
          size={72}
          label={t('profileSection.previewAria', { kind: t(PROFILE_KIND_LABEL[type]), across: formatSectionMetres(across), up: formatSectionMetres(up) })}
          className="rounded-sm border border-border bg-muted/30 text-foreground"
        />
      </div>
      {problem && <p role="alert" data-profile-problem className="text-2xs leading-snug text-destructive">{t('profileSection.invalid', { kind: t(PROFILE_KIND_LABEL[type]), reason: problem })}</p>}
    </div>
  );
}
