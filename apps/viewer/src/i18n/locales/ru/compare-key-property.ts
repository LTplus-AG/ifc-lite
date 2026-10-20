/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const compareKeyPropertyRu = {
  "compareKeyProperty.label": "Ключ сопоставления",
  "compareKeyProperty.placeholder": "Tag или Pset.Prop",
  "compareKeyProperty.globalId": "GlobalId",
  "compareKeyProperty.invalidNote": "Недействительный ключ — используйте Tag или Pset.Property. Сравнение продолжается на {scheme}.",
  "compareKeyProperty.duplicateNote": {
    few: "Для {count} авторских значений, общих для нескольких элементов, использован GlobalId: {values}",
    many: "Для {count} авторских значений, общих для нескольких элементов, использован GlobalId: {values}",
    other: "Для {count} авторского значения, общего для нескольких элементов, использован GlobalId: {values}",
  },
} satisfies Catalogue;
