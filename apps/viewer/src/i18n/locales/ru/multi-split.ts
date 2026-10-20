/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const multiSplitRu = {
  "multiSplit.label": "Разделить линией",
  "multiSplit.tool": "Разделить линией",
  "commands.model.splitMulti": "Разделить всё вдоль линии (рабочая область модели)",
  "multiSplit.hintStart": "Щёлкните по первой точке линии разреза · выделенный фрагмент, или этаж, разделится вдоль неё · Нажмите Esc, чтобы закрыть",
  "multiSplit.hintEnd": "Укажите вторую точку или нажмите Enter, чтобы разделить пересекаемые линией элементы · Backspace начинает линию заново · Esc начинает заново",
  "multiSplit.noTargets": "Здесь нечего разделять: выберите элементы или этаж со стенами, балками или плитами",
  "multiSplit.needLine": "Сначала нарисуйте линию разреза: две точки",
  "multiSplit.crossesNothing": "Линия не пересекает ничего, что можно разделить",
  "multiSplit.nothingSplittable": "Все элементы, пересекаемые линией, отклонены: ничего не будет разделено",
  "multiSplit.scope.selection": {
    one: "Выбрано: {countDisplay} элемент",
    many: "Выбрано: {countDisplay} элементов",
    other: "Выбрано: {countDisplay} элемента",
  },
  "multiSplit.scope.storey": {
    one: "Этаж: {countDisplay} стена, балка или плита",
    few: "Этаж: {countDisplay} стены, балки и плиты",
    many: "Этаж: {countDisplay} стен, балок и плит",
    other: "Этаж: {countDisplay} стены, балки или плиты",
  },
  "multiSplit.bar.splits": {
    one: "{countDisplay} будет разделён",
    few: "{countDisplay} будут разделены",
    many: "{countDisplay} будут разделены",
    other: "{countDisplay} будет разделено",
  },
  "multiSplit.bar.refused": {
    one: "{countDisplay} отклонён",
    few: "{countDisplay} отклонены",
    many: "{countDisplay} отклонены",
    other: "{countDisplay} отклонено",
  },
  "multiSplit.refused.otherModel": "Принадлежит к другой модели, а не к той, которая редактируется",
  "multiSplit.refused.column": "Разделить невозможно: вертикальный разрез не пересекает колонну вдоль",
  "multiSplit.refused.vertical": "Разделение невозможно: у вертикального элемента нет оси в плане, которую могла бы пересечь линия",
  "multiSplit.refused.nearEnd": "Разделить невозможно: линия пересекает элемент ближе {min} см от его конца",
  "multiSplit.done": {
    one: "Разделён {countDisplay} элемент",
    few: "Разделены {countDisplay} элемента",
    many: "Разделено {countDisplay} элементов",
    other: "Разделено {countDisplay} элемента",
  },
  "multiSplit.leftAlone": {
    one: "{countDisplay} элемент, пересекаемый линией, оставлен без изменений (см. причину рядом с каждым)",
    few: "{countDisplay} элемента, пересекаемых линией, оставлены без изменений (см. причину рядом с каждым)",
    many: "{countDisplay} элементов, пересекаемых линией, оставлены без изменений (см. причину рядом с каждым)",
    other: "{countDisplay} элемента, пересекаемого линией, оставлено без изменений (см. причину рядом с каждым)",
  },
  "multiSplit.openingsSkipped": {
    one: "Не удалось переназначить {countDisplay} проём; может потребоваться ручное перемещение",
    many: "Не удалось переназначить {countDisplay} проёмов; может потребоваться ручное перемещение",
    other: "Не удалось переназначить {countDisplay} проёма; может потребоваться ручное перемещение",
  },
  "commandPalette.tool.splitMulti.label": "Разделить линией",
} satisfies Catalogue;
