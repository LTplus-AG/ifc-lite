/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const groupReviewRu = {
  "groupReview.title": "Проверить изменения групп",
  "groupReview.hint": "Выберите изменения, затем проверьте имена групп и полный состав. При удалении группы её участники и их членство в других группах сохраняются.",
  "groupReview.prepare": "Проверить выбранные изменения групп",
  "groupReview.acknowledgement": "Я проверил полный состав группы и общие ссылки.",
  "groupReview.population": "Исходные записи: создано {created} · изменено {modified} · удалено {deleted}",
  "groupReview.nativeChanges": "Проверить изменения групп и общие ссылки",
  "groupReview.receiptProblem": "Изменения были применены, но сохранить их подтверждение не удалось. Функция отмены по-прежнему доступна в истории изменений.",
  "groupReview.op.group.create": "Создать группу",
  "groupReview.op.group.update": "Обновить группу и заменить весь состав участников",
  "groupReview.op.group.remove": "Удалить группу",
} satisfies Catalogue;
