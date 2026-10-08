/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import './content-fixture.js';
import { beforeEach } from 'node:test';
import { forgetContentImports, pendingContentImports } from '@/lib/storage/content-import-plan';
import { forgetContentDrafts, pendingContentDrafts } from '@/lib/storage/content-backup-drafts';

beforeEach(() => {
  forgetContentImports(pendingContentImports());
  forgetContentDrafts(pendingContentDrafts());
});
