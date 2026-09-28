/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { setLocale } from '@/i18n';
import { bcfEn } from '@/i18n/catalogues/bcf.en';
import { BCFTopicList } from './BCFTopicList.js';

afterEach(() => cleanup());

it('names the BCF author editor and saves from the mounted empty state (#6342)', () => {
  setLocale('en');
  const saved: string[] = [];
  const container = render(
    <BCFTopicList
      topics={[]}
      onSelectTopic={() => {}}
      onCreateTopic={() => {}}
      statusFilter="all"
      onStatusFilterChange={() => {}}
      author="user@example.com"
      onSetAuthor={(author) => saved.push(author)}
    />,
  );
  const setEmail = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === bcfEn['bcf.topicList.setEmail'],
  );
  assert.ok(setEmail, 'the empty state offers author setup');
  click(setEmail);

  const input = container.querySelector<HTMLInputElement>('input[placeholder]');
  assert.ok(input, 'author setup reveals its input');
  assert.equal(input.labels?.length, 1);
  assert.equal(input.labels?.[0]?.textContent, bcfEn['bcf.topicList.emailAuthorshipLabel']);

  const save = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === bcfEn['bcf.shared.save'],
  );
  assert.ok(save);
  click(save);
  assert.deepEqual(saved, ['user@example.com']);
});
