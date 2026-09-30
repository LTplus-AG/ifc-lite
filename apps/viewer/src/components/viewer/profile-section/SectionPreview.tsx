/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A section drawn to fit a small square, as the mesher builds it
 * (`profile-outline.ts`): the picker's kind buttons and its preview.
 */

import type { ProfileSection } from '@ifc-lite/create';
import { sectionPath } from '@/lib/profile-section/profile-outline';

interface SectionPreviewProps {
  section: ProfileSection;
  /** Side of the square, px. */
  size: number;
  /** Accessible name; the drawing is decorative when absent. */
  label?: string;
  className?: string;
}

export function SectionPreview({ section, size, label, className }: SectionPreviewProps) {
  const path = sectionPath(section, size);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-section-preview={section.Type}
      className={className}
    >
      {path && <path d={path} fill="currentColor" fillRule="evenodd" fillOpacity={0.85} />}
    </svg>
  );
}
