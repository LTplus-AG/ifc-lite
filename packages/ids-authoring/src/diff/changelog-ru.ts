/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChangelogCatalogue } from './changelog-text.js';

export const ru: ChangelogCatalogue = {
  section: {
    applicability: "область применения",
    requirements: "требование",
  },
  optionality: {
    required: "обязательное",
    optional: "необязательное",
    prohibited: "запрещено",
  },
  cardinality: {
    required: "обязательная",
    optional: "необязательная",
    prohibited: "запрещённая",
  },
  info: {
    title: "Название",
    copyright: "Авторское право",
    version: "Версия",
    description: "Описание",
    author: "Автор",
    date: "Дата",
    purpose: "Назначение",
    milestone: "Этап",
  },
  specField: {
    description: "описание",
    instructions: "инструкции",
    identifier: "идентификатор",
    ifcVersions: "версии IFC",
    ifcVersionRaw: "текст версии IFC",
    minOccurs: "минимальное число вхождений",
    maxOccurs: "максимальное число вхождений",
    applicabilityCardinality: "кратность области применения",
  },
  reqField: {
    cardinalityRaw: "кратность",
    description: "описание",
    instructions: "инструкции",
  },
  none: "не задано",
  changed: (w, f, t) => `${w} изменяется с ${f} на ${t}`,
  set: (w, t) => `${w} задаётся как ${t}`,
  removedValue: (w, f) => `${w} удаляется (было ${f})`,
  specAdded: (n) => `Спецификация "${n}" добавлена`,
  specRemoved: (n) => `Спецификация "${n}" удалена`,
  specMoved: (n, f, t) => `Спецификация "${n}" перемещена с позиции ${f} на позицию ${t}`,
  specRenamed: (f, t) => `Спецификация "${f}" переименована в "${t}"`,
  specCardinality: (n, f, t) => `Спецификация "${n}" изменена с ${f} на ${t}`,
  facetAdded: (s, t) => `${s} добавляется: ${t}`,
  facetRemoved: (s, t) => `${s} удаляется: ${t}`,
  facetMoved: (t, f, to) => `"${t}" перемещается из ${f} в ${to}`,
  facetReplaced: (f, t) => `"${f}" заменяется на "${t}"`,
  position: (n) => `позиция ${n}`,
  inSpec: (s, sec) => `${sec} спецификации "${s}"`,
  psetDeclared: (n) => `Пользовательский набор свойств ${n} объявлен`,
  psetRemoved: (n) => `Пользовательский набор свойств ${n} больше не объявлен`,
  udtDeclared: (e, v) => `Пользовательский тип ${v} объявлен для ${e}`,
  udtRemoved: (e, v) => `Пользовательский тип ${v} для ${e} больше не объявлен`,
  relation: "отношение",
};
