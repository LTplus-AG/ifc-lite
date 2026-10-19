/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowReviewRu = {
  "flowReview.title": "Проверить предложение ИИ",
  "flowReview.paused": "Выполнение приостановлено на {nodes}. Последующие узлы не выполняются, пока вы не одобрите это предложение.",
  "flowReview.node": "{node} ({type})",
  "flowReview.digest": "Предложение {digest}",
  "flowReview.created": "Сохранено для проверки {time}",
  "flowReview.coverage.classify": "Строк {rows} · классифицировано {classified} · неизвестно {unknown} · с ошибками {failed} · не отправлено {notSent} · запросов {requests} · модель {model}",
  "flowReview.coverage.summarize": "Строк {rows} · отправлено {sent} · разделов {sections} · без ссылок {uncited} · запросов {requests} · модель {model}",
  "flowReview.coverage.extract": "Фрагментов {passages} · отправлено {sent} · записей {records} · не поддерживается {unsupported} · запросов {requests} · модель {model}",
  "flowReview.approve": "Одобрить и возобновить",
  "flowReview.resume": "Продолжить",
  "flowReview.reject": "Отклонить",
  "flowReview.dismiss": "Закрыть",
  "flowReview.state.prepared": "Последующие узлы не запускались. Одобрите, чтобы продолжить запуск именно с этим предложением, или отклоните его.",
  "flowReview.state.reviewed": "Одобрено. Команда Продолжить выполняет оставшуюся часть графа именно с этим предложением.",
  "flowReview.state.applying": "Возобновление с одобренного предложения…",
  "flowReview.state.completed": "Возобновлено с утверждённого предложения. Узлы, завершившие работу до паузы, были восстановлены, не запускались повторно, и новый запрос ИИ по этому предложению не отправлялся.",
  "flowReview.state.partial": "Возобновление не завершилось ({reason}). Последующие эффекты могут быть частичными; возобновить выполнение по этому предложению повторно нельзя. Запустите граф снова для нового ревью.",
  "flowReview.state.rejected": "Отклонено. Ничего после предложения не выполнялось.",
  "flowReview.refused.graph-changed": "Граф или его входы запуска изменились после создания этого предложения. Запустите граф снова для новой проверки.",
  "flowReview.refused.sources-changed": "После внесения этого предложения модели или внесённые в них изменения изменились. Для повторного анализа запустите граф.",
  "flowReview.refused.other": "Данное предложение не может быть возобновлено: {reason}",
  "flowReview.notSaved": "Не удалось сохранить предложение для проверки, поэтому ничего после него не выполнялось: {reason}",
  "flowReview.needsModel": "Узлы ИИ используют модель, выбранную для Помощника. Выберите модель или добавьте для неё ключ, чтобы запустить этот граф.",
} satisfies Catalogue;
