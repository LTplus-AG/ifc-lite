# @ifc-lite/documents-api

Client for the buildingSMART [OpenCDE Documents API 1.0](https://github.com/buildingSMART/documents-API) — select, download and upload documents through a CDE's own UI flows, and poll for new document versions.

Most of this API is link-driven: after the first call, the server hands back the URL for the next step, so most of `DocumentsApiClient`'s methods take that URL as their argument rather than building one from a fixed path. Discovery and OAuth2 auth build on [`@ifc-lite/opencde-foundation`](https://www.npmjs.com/package/@ifc-lite/opencde-foundation).

Works in the browser and in Node (uses the global `fetch`; injectable for tests).

## Install

```bash
npm install @ifc-lite/documents-api @ifc-lite/opencde-foundation
```

## Discover the service and select documents

<!-- docs-check: skip -->
```ts
import { discoverDocumentsService, DocumentsApiClient, parseSelectDocumentsCallback } from '@ifc-lite/documents-api';

const { baseUrl } = await discoverDocumentsService({ baseUrl: 'https://example.com' });
const client = new DocumentsApiClient({ baseUrl, getAccessToken: () => accessToken });

// 1. Start the flow: the CDE returns a URL to open in the user's browser.
const { select_documents_url } = await client.selectDocuments({
  callback: { url: 'https://myapp.example/oauth/documents/callback', expires_in: 600 },
  supported_file_extensions: ['.ifc', '.ifczip'],
});
openInBrowser(select_documents_url);

// 2. The CDE redirects your callback URL once the user finishes selecting
//    documents; parse the query string it appended.
const result = parseSelectDocumentsCallback(callbackRequestUrl);
if (result.status === 'selected') {
  const { documents } = await client.getSelectedDocuments(result.selectedDocumentsUrl);
  for (const doc of documents) {
    const metadata = await client.getDocumentMetadata(doc.links.document_version_metadata.url);
    const blob = await client.downloadDocumentVersion(doc.links.document_version_download.url);
  }
}
```

## Poll for new versions

```ts
import { DocumentsApiClient } from '@ifc-lite/documents-api';

declare const client: DocumentsApiClient;
declare const previousEtag: string | undefined;

const poll = await client.queryDocumentVersions(['doc-1', 'doc-2'], previousEtag);
// null when nothing changed since previousEtag (the server answered 304);
// otherwise poll.result holds the versions and poll.etag is what to send next time
const nextEtag = poll?.etag ?? previousEtag;
```

## Upload a file

<!-- docs-check: skip -->
```ts
import { DocumentsApiClient, parseUploadDocumentsCallback } from '@ifc-lite/documents-api';

// 1. Start the flow with the files you intend to upload.
const { upload_ui_url } = await client.uploadDocuments({
  callback: { url: 'https://myapp.example/oauth/documents/upload-callback', expires_in: 600 },
  files: [{ file_name: 'plan.ifc', session_file_id: 'f1' }],
});
openInBrowser(upload_ui_url);

// 2. Once the user finishes entering metadata on the CDE, send each file's
//    size so the server can plan the multipart split.
const uploadResult = parseUploadDocumentsCallback(callbackRequestUrl);
if (uploadResult.status === 'ready') {
  const plan = await client.getUploadInstructions(uploadResult.uploadDocumentsUrl, [
    { size_in_bytes: fileBytes.byteLength, session_file_id: 'f1' },
  ]);
  const file = plan.documents_to_upload[0];

  // 3. Upload every part (concurrently and in any order is fine), then complete.
  await Promise.all(file.upload_file_parts.map((part) => client.uploadFilePart(part, fileBytes)));
  const newVersion = await client.completeUpload(file.upload_completion.url);
  // or, to abandon it: await client.cancelUpload(file.upload_cancellation.url);
}
```

Errors are `DocumentsApiError` (`status`, `url`, `isAuthError`) — `@ifc-lite/opencde-foundation`'s `FoundationApiError` under this package's name.

## License

MPL-2.0
