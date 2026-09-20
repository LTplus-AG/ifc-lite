/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Box, Cog, DoorOpen, Home, Layers, Minus, Square, SquareDashedBottom } from 'lucide-react';
import type { TranslationKey } from '@/i18n';
import type { AddElementType } from '@/store/slices/addElementSlice';

export interface ElementOption {
  type: AddElementType;
  labelKey: TranslationKey;
  Icon: typeof Box;
  hintKey: TranslationKey;
}

export const ELEMENT_OPTIONS: ElementOption[] = [
  { type: 'wall', labelKey: 'addElement.type.wall', Icon: Minus, hintKey: 'addElement.hint.wall' },
  { type: 'slab', labelKey: 'addElement.type.slab', Icon: Square, hintKey: 'addElement.hint.slab' },
  { type: 'beam', labelKey: 'addElement.type.beam', Icon: Layers, hintKey: 'addElement.hint.beam' },
  { type: 'column', labelKey: 'addElement.type.column', Icon: Box, hintKey: 'addElement.hint.column' },
  { type: 'door', labelKey: 'addElement.type.door', Icon: DoorOpen, hintKey: 'addElement.hint.door' },
  { type: 'window', labelKey: 'addElement.type.window', Icon: SquareDashedBottom, hintKey: 'addElement.hint.window' },
  { type: 'space', labelKey: 'addElement.type.space', Icon: Home, hintKey: 'addElement.hint.space' },
  { type: 'roof', labelKey: 'addElement.type.roof', Icon: Square, hintKey: 'addElement.hint.roof' },
  { type: 'plate', labelKey: 'addElement.type.plate', Icon: Square, hintKey: 'addElement.hint.plate' },
  { type: 'member', labelKey: 'addElement.type.member', Icon: Cog, hintKey: 'addElement.hint.member' },
];

/** IFC4 IfcSpaceTypeEnum literals stay exact and are not translated. */
export const SPACE_PREDEFINED_TYPES = ['INTERNAL', 'EXTERNAL', 'SPACE', 'PARKING', 'GFA', 'USERDEFINED', 'NOTDEFINED'] as const;
