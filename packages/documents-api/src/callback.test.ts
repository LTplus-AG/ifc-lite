/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseSelectDocumentsCallback, parseUploadDocumentsCallback } from './callback.js';

describe('parseSelectDocumentsCallback', () => {
  it('extracts selected_documents_url from the redirect', () => {
    const result = parseSelectDocumentsCallback(
      'https://client.example/cb?selected_documents_url=https%3A%2F%2Fcde.example%2Fsel%2F1',
    );
    expect(result).toEqual({ status: 'selected', selectedDocumentsUrl: 'https://cde.example/sel/1' });
  });

  it('reports cancellation when the user cancelled the selection', () => {
    const result = parseSelectDocumentsCallback('https://client.example/cb?user_cancelled_selection=true');
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('accepts a bare query string and a URLSearchParams directly', () => {
    expect(parseSelectDocumentsCallback('selected_documents_url=https://cde.example/x')).toEqual({
      status: 'selected',
      selectedDocumentsUrl: 'https://cde.example/x',
    });
    expect(
      parseSelectDocumentsCallback(new URLSearchParams('selected_documents_url=https://cde.example/y')),
    ).toEqual({ status: 'selected', selectedDocumentsUrl: 'https://cde.example/y' });
  });

  it('throws when the callback carries neither param', () => {
    expect(() => parseSelectDocumentsCallback('https://client.example/cb')).toThrow(
      'neither selected_documents_url nor user_cancelled_selection',
    );
  });
});

describe('parseUploadDocumentsCallback', () => {
  it('extracts upload_documents_url from the redirect', () => {
    const result = parseUploadDocumentsCallback(
      'https://client.example/cb?upload_documents_url=https%3A%2F%2Fcde.example%2Fup%2F1',
    );
    expect(result).toEqual({ status: 'ready', uploadDocumentsUrl: 'https://cde.example/up/1' });
  });

  it('reports cancellation when the user cancelled the upload', () => {
    const result = parseUploadDocumentsCallback('https://client.example/cb?user_cancelled_upload=true');
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('throws when the callback carries neither param', () => {
    expect(() => parseUploadDocumentsCallback('https://client.example/cb')).toThrow(
      'neither upload_documents_url nor user_cancelled_upload',
    );
  });
});
