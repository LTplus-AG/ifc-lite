/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FetchLike } from '@ifc-lite/opencde-foundation';
import { FoundationApiError } from '@ifc-lite/opencde-foundation';
import { describe, expect, it } from 'vitest';
import { DocumentsApiClient } from './client.js';
import type { DocumentVersion } from './types.js';

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchFn: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, requests };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const DOCUMENT_VERSION: DocumentVersion = {
  links: {
    document_version: { url: 'https://cde.example/dv/1' },
    document_version_metadata: { url: 'https://cde.example/dv/1/metadata' },
    document_version_download: { url: 'https://cde.example/dv/1/download' },
    document_versions: { url: 'https://cde.example/documents/d1/versions' },
  },
  version_number: 'A',
  version_index: 1,
  creation_date: '2026-01-01T00:00:00Z',
  title: 'Floor plan',
  file_description: { name: 'plan.ifc', size_in_bytes: 1024 },
  document_id: 'd1',
};

describe('DocumentsApiClient selection/download flow', () => {
  it('POSTs /select-documents relative to the client base URL', async () => {
    const { fetchFn, requests } = mockFetch(() =>
      jsonResponse({ select_documents_url: 'https://cde.example/ui/select', expires_in: 600 }),
    );
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0/', fetchFn });
    const session = await client.selectDocuments({
      callback: { url: 'https://client.example/cb', expires_in: 600 },
      supported_file_extensions: ['.ifc'],
    });
    expect(session.select_documents_url).toBe('https://cde.example/ui/select');
    expect(requests[0].url).toBe('https://cde.example/documents/1.0/select-documents');
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      callback: { url: 'https://client.example/cb', expires_in: 600 },
      supported_file_extensions: ['.ifc'],
    });
  });

  it('follows server-provided links directly, without rewriting them against the base URL', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse({ documents: [DOCUMENT_VERSION] }));
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    const selected = await client.getSelectedDocuments('https://cde.example/selection/xyz');
    expect(selected.documents[0].document_id).toBe('d1');
    expect(requests[0].url).toBe('https://cde.example/selection/xyz');
  });

  it('fetches metadata, versions and a single version via their own links', async () => {
    const { fetchFn, requests } = mockFetch((url) => {
      if (url.endsWith('/metadata')) {
        return jsonResponse({ metadata: [{ name: 'discipline', value: ['ARC'], data_type: 'string' }] });
      }
      if (url.endsWith('/versions')) return jsonResponse({ documents: [DOCUMENT_VERSION] });
      return jsonResponse(DOCUMENT_VERSION);
    });
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    const metadata = await client.getDocumentMetadata(DOCUMENT_VERSION.links.document_version_metadata.url);
    expect(metadata.metadata[0].name).toBe('discipline');
    const versions = await client.getDocumentVersions(DOCUMENT_VERSION.links.document_versions.url);
    expect(versions.documents).toHaveLength(1);
    const version = await client.getDocumentVersion(DOCUMENT_VERSION.links.document_version.url);
    expect(version.document_id).toBe('d1');
    expect(requests.map((r) => r.url)).toEqual([
      DOCUMENT_VERSION.links.document_version_metadata.url,
      DOCUMENT_VERSION.links.document_versions.url,
      DOCUMENT_VERSION.links.document_version.url,
    ]);
  });

  it('downloads a document version as a Blob with its content type', async () => {
    const bytes = new Uint8Array([0x49, 0x46, 0x43]);
    const { fetchFn, requests } = mockFetch(
      () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    const blob = await client.downloadDocumentVersion(DOCUMENT_VERSION.links.document_version_download.url);
    expect(blob.type).toBe('application/octet-stream');
    expect(blob.size).toBe(3);
    expect(requests[0].url).toBe(DOCUMENT_VERSION.links.document_version_download.url);
  });
});

describe('DocumentsApiClient query/polling flow', () => {
  it('POSTs /document-versions with the tracked ids and an optional If-None-Match', async () => {
    const { fetchFn, requests } = mockFetch(() =>
      jsonResponse({ versions: [DOCUMENT_VERSION] }, 200, { ETag: 'v1' }),
    );
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    const result = await client.queryDocumentVersions(['d1', 'd2'], 'prev-etag');
    expect(result?.versions).toHaveLength(1);
    expect(requests[0].url).toBe('https://cde.example/documents/1.0/document-versions');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ document_ids: ['d1', 'd2'] });
    expect(new Headers(requests[0].init?.headers).get('If-None-Match')).toBe('prev-etag');
  });

  it('returns null on a 304, without throwing', async () => {
    const { fetchFn } = mockFetch(() => new Response(null, { status: 304 }));
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    const result = await client.queryDocumentVersions(['d1'], 'current-etag');
    expect(result).toBeNull();
  });

  it('surfaces a real error as a FoundationApiError', async () => {
    const { fetchFn } = mockFetch(() => jsonResponse({ message: 'bad ids' }, 400));
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    const error = await client.queryDocumentVersions(['??']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FoundationApiError);
    expect((error as FoundationApiError).status).toBe(400);
  });
});

describe('DocumentsApiClient upload flow', () => {
  it('runs upload-documents -> instructions -> parts -> completion', async () => {
    const partBytes: Record<string, Uint8Array> = {};
    const { fetchFn, requests } = mockFetch(async (url, init) => {
      if (url.endsWith('/upload-documents')) {
        return jsonResponse({ upload_ui_url: 'https://cde.example/ui/upload', expires_in: 600, max_size_in_bytes: 1e9 });
      }
      if (url === 'https://cde.example/upload-session/abc') {
        return jsonResponse({
          documents_to_upload: [
            {
              session_file_id: 'f1',
              upload_file_parts: [
                {
                  url: 'https://storage.example/part-1',
                  http_method: 'PUT',
                  content_range_start: 0,
                  content_range_end: 3,
                },
              ],
              upload_completion: { url: 'https://cde.example/upload/f1/complete' },
              upload_cancellation: { url: 'https://cde.example/upload/f1/cancel' },
            },
          ],
        });
      }
      if (url === 'https://storage.example/part-1') {
        partBytes.part1 = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/complete')) return jsonResponse(DOCUMENT_VERSION);
      throw new Error(`unexpected request: ${url}`);
    });

    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    const session = await client.uploadDocuments({
      callback: { url: 'https://client.example/cb', expires_in: 600 },
      files: [{ file_name: 'plan.ifc', session_file_id: 'f1' }],
    });
    expect(session.max_size_in_bytes).toBe(1e9);

    const plan = await client.getUploadInstructions('https://cde.example/upload-session/abc', [
      { size_in_bytes: 4, session_file_id: 'f1' },
    ]);
    const file = plan.documents_to_upload[0];
    expect(file.upload_file_parts).toHaveLength(1);

    const content = new Uint8Array([1, 2, 3, 4]);
    await client.uploadFilePart(file.upload_file_parts[0], content);
    expect(partBytes.part1).toEqual(content);

    const completed = await client.completeUpload(file.upload_completion.url);
    expect(completed.document_id).toBe('d1');
    expect(requests.map((r) => r.url)).toEqual([
      'https://cde.example/documents/1.0/upload-documents',
      'https://cde.example/upload-session/abc',
      'https://storage.example/part-1',
      'https://cde.example/upload/f1/complete',
    ]);
  });

  it('wraps a part with the server-provided multipart prefix/suffix', async () => {
    const { fetchFn } = mockFetch(async (url, init) => {
      if (url !== 'https://storage.example/part-1') throw new Error(`unexpected ${url}`);
      const sent = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      // 'AAA=' -> [0x00, 0x00], 'BBA=' -> [0x04, 0x10] as base64, content [9] in between.
      expect(Array.from(sent)).toEqual([0, 0, 9, 4, 16]);
      return new Response(null, { status: 200 });
    });
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    await client.uploadFilePart(
      {
        url: 'https://storage.example/part-1',
        http_method: 'PUT',
        content_range_start: 0,
        content_range_end: 0,
        multipart_form_data: {
          prefix: btoa(String.fromCharCode(0, 0)),
          suffix: btoa(String.fromCharCode(4, 16)),
        },
      },
      new Uint8Array([9]),
    );
  });

  it('cancels an upload with a POST to its cancellation link', async () => {
    const { fetchFn, requests } = mockFetch(() => new Response(null, { status: 204 }));
    const client = new DocumentsApiClient({ baseUrl: 'https://cde.example/documents/1.0', fetchFn });
    await client.cancelUpload('https://cde.example/upload/f1/cancel');
    expect(requests[0].url).toBe('https://cde.example/upload/f1/cancel');
    expect(requests[0].init?.method).toBe('POST');
  });

  it('includes Authorization on a part only when include_authorization is set', async () => {
    const { fetchFn, requests } = mockFetch(() => new Response(null, { status: 200 }));
    const client = new DocumentsApiClient({
      baseUrl: 'https://cde.example/documents/1.0',
      fetchFn,
      getAccessToken: () => 'secret-token',
    });
    await client.uploadFilePart(
      { url: 'https://storage.example/p', http_method: 'PUT', content_range_start: 0, content_range_end: 0 },
      new Uint8Array([1]),
    );
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBeNull();

    await client.uploadFilePart(
      {
        url: 'https://storage.example/p',
        http_method: 'PUT',
        content_range_start: 0,
        content_range_end: 0,
        include_authorization: true,
      },
      new Uint8Array([1]),
    );
    expect(new Headers(requests[1].init?.headers).get('Authorization')).toBe('Bearer secret-token');
  });
});
