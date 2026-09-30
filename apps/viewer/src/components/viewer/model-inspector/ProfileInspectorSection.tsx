/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's Profile section for beams, columns and members
 * (charter #6232, D2): the cross-section of the selected element, or in
 * Defaults mode the section new elements are built with.
 *
 * Selection mode changes the kind (a rectangle to an I, a circle to a hollow
 * circle) or a dimension of the picked kind, each ONE undo step through
 * `setElementProfile`, re-meshed through the transaction: the write the
 * commands' section picker and a push / pull of a rectangle's faces share.
 * The new kind starts at the element's own outer size, so switching does not
 * jump the element to a default size. A rectangle's two sides are sized in
 * Dimensions, not here.
 */

import { useMemo } from 'react';
import type { ProfileSection, ProfileSectionType } from '@ifc-lite/create';
import { profileSectionExtent } from '@ifc-lite/create';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import type { AuthoredElementKind, ProfileOwner } from '@/store/slices/authoringDefaultsSlice';
import { PROFILE_FIELDS, PROFILE_KIND_LABEL, sectionDimensions, sectionProblem, sectionWithExtent, withDimension } from '@/lib/profile-section/profile-kinds';
import { DefaultsProfileEditor } from '../profile-section/DefaultsProfileEditor';
import { ProfileEditor, type ProfileEditorField } from '../profile-section/ProfileEditor';
import { InspectorCaption, InspectorSection } from './InspectorControls';
import { setElementProfileSection } from './inspector-edits';
import type { InspectorSelection } from './useInspectorTarget';

/** The kinds whose cross-section the inspector edits. */
export const isProfileOwner = (kind: AuthoredElementKind | null): kind is ProfileOwner => kind === 'beam' || kind === 'column' || kind === 'member';

export function DefaultProfile({ owner }: { owner: ProfileOwner }) {
  const { t } = useTranslation();
  return (
    <InspectorSection title={t('profileSection.inspector.title')}>
      <DefaultsProfileEditor owner={owner} />
    </InspectorSection>
  );
}

export function SelectionProfile({ selection, owner }: { selection: InspectorSelection; owner: ProfileOwner }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const remembered = useViewerStore((s) => s.authoringDefaults.profiles[owner].dims);
  const { modelId, expressId } = selection;
  const current = useMemo(() => { void mutationVersion; return readElementProfile(useViewerStore.getState(), modelId, expressId); }, [modelId, expressId, mutationVersion]);

  if (!current) {
    return (
      <InspectorSection title={t('profileSection.inspector.title')}>
        <InspectorCaption>{t('profileSection.inspector.unavailable')}</InspectorCaption>
      </InspectorSection>
    );
  }

  const onType = (type: ProfileSectionType) => {
    const [across, up] = profileSectionExtent(current);
    const next: ProfileSection = type === 'Rectangle' ? { Type: 'Rectangle', XDim: across, YDim: up } : sectionWithExtent(type, [across, up], remembered[type]);
    setElementProfileSection(modelId, expressId, next);
  };
  const onField = (id: string, metres: number): boolean => {
    const next = withDimension(current, id, metres);
    const problem = sectionProblem(next);
    if (problem) {
      toast.error(t('profileSection.invalid', { kind: t(PROFILE_KIND_LABEL[current.Type]), reason: problem }));
      return false;
    }
    return setElementProfileSection(modelId, expressId, next);
  };
  const values = sectionDimensions(current);
  const fields: ProfileEditorField[] = current.Type === 'Rectangle'
    ? []
    : PROFILE_FIELDS[current.Type].map((field) => ({ id: field.name, label: t(field.labelKey), value: values[field.name] }));

  return (
    <InspectorSection title={t('profileSection.inspector.title')}>
      <ProfileEditor type={current.Type} onType={onType} section={current} fields={fields} onField={onField} />
      {current.Type === 'Rectangle' && <InspectorCaption>{t('profileSection.inspector.dimsNote')}</InspectorCaption>}
    </InspectorSection>
  );
}
