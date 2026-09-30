/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cross-section a new beam, column or member is built with (charter
 * #6232, D2), edited in the defaults slice: the Section picker's popover in
 * the command bar and the Model inspector's Defaults mode show this one
 * component, so the two always agree and a section typed in one is what the
 * next element gets.
 */

import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { authoringSection, authoringShownSection, type ProfileOwner } from '@/store/slices/authoringDefaultsSlice';
import { PROFILE_FIELDS, PROFILE_KIND_LABEL, sectionDimensions, sectionProblem, withDimension } from '@/lib/profile-section/profile-kinds';
import { ProfileEditor, type ProfileEditorField } from './ProfileEditor';

export function DefaultsProfileEditor({ owner, className }: { owner: ProfileOwner; className?: string }) {
  const { t } = useTranslation();
  const defaults = useViewerStore((s) => s.authoringDefaults);
  const setProfile = useViewerStore((s) => s.setAuthoringProfile);
  const { type } = defaults.profiles[owner];
  const section = authoringSection(defaults, owner);
  const shown = authoringShownSection(defaults, owner);
  const values = sectionDimensions(shown);
  // A rectangle's two sides are typed in the bar and in Dimensions; the picker adds fields only for the shapes.
  const fields: ProfileEditorField[] = section === null
    ? []
    : PROFILE_FIELDS[type].map((field) => ({ id: field.name, label: t(field.labelKey), value: values[field.name] }));

  const onField = (id: string, metres: number): boolean => {
    if (section === null) return false;
    const problem = sectionProblem(withDimension(section, id, metres));
    if (problem) {
      toast.error(t('profileSection.invalid', { kind: t(PROFILE_KIND_LABEL[type]), reason: problem }));
      return false;
    }
    setProfile(owner, type, { [id]: metres });
    return true;
  };

  return <ProfileEditor type={type} onType={(next) => setProfile(owner, next)} section={shown} fields={fields} onField={onField} className={className} />;
}
