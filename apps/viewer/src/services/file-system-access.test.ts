/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// happy-dom registers `window`/`DOMException` globally.
import '../test/setup-dom.js';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  handlesFromDataTransfer,
  openIfcFilesWithHandles,
  readFreshFile,
  supportsFileSystemAccess,
} from './file-system-access.js';
import { MODEL_FILE_EXTENSIONS, isSupportedModelFile } from './supported-model-files.js';

type FSFileHandleLike = {
  name: string;
  kind: 'file';
  getFile: () => Promise<File>;
  queryPermission?: (opts: { mode: string }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (opts: { mode: string }) => Promise<'granted' | 'denied' | 'prompt'>;
};

function fakeFile(name: string): File {
  return new File(['content'], name, { type: 'application/octet-stream' });
}

function fakeHandle(name: string, overrides: Partial<FSFileHandleLike> = {}): FSFileHandleLike {
  return {
    name,
    kind: 'file',
    getFile: async () => fakeFile(name),
    ...overrides,
  };
}

describe('file-system-access', () => {
  let originalShowOpenFilePicker: unknown;

  beforeEach(() => {
    originalShowOpenFilePicker = (window as unknown as Record<string, unknown>).showOpenFilePicker;
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).showOpenFilePicker = originalShowOpenFilePicker;
  });

  describe('supportsFileSystemAccess', () => {
    it('is false when showOpenFilePicker is absent', () => {
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
      assert.equal(supportsFileSystemAccess(), false);
    });

    it('is true when showOpenFilePicker is a function', () => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [];
      assert.equal(supportsFileSystemAccess(), true);
    });
  });

  describe('openIfcFilesWithHandles', () => {
    it('returns null when the API is unavailable', async () => {
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
      const result = await openIfcFilesWithHandles();
      assert.equal(result, null);
    });

    it('returns null (not an error) when the user cancels the picker (AbortError), without a console warning', async () => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      };
      const originalWarn = console.warn;
      let warned = false;
      console.warn = () => {
        warned = true;
      };
      try {
        const result = await openIfcFilesWithHandles();
        assert.equal(result, null);
        assert.equal(warned, false, 'a routine user cancellation must not be logged as a warning');
      } finally {
        console.warn = originalWarn;
      }
    });

    it('returns null AND logs a warning when the picker fails for a non-abort reason', async () => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => {
        throw new Error('some other picker failure');
      };
      const originalWarn = console.warn;
      let warned = false;
      console.warn = () => {
        warned = true;
      };
      try {
        const result = await openIfcFilesWithHandles();
        assert.equal(result, null);
        assert.equal(warned, true, 'a genuine picker failure should be surfaced');
      } finally {
        console.warn = originalWarn;
      }
    });

    it('returns files+handles for a successful pick', async () => {
      const handles = [fakeHandle('a.ifc'), fakeHandle('b.ifc')];
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => handles;
      const result = await openIfcFilesWithHandles();
      assert.ok(result);
      assert.equal(result.length, 2);
      assert.equal(result[0].file.name, 'a.ifc');
      assert.equal(result[0].handle, handles[0]);
    });

    it('skips a handle whose getFile() fails, but still returns the others', async () => {
      const badHandle = fakeHandle('broken.ifc', {
        getFile: async () => {
          throw new Error('file moved');
        },
      });
      const goodHandle = fakeHandle('ok.ifc');
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [badHandle, goodHandle];
      const result = await openIfcFilesWithHandles();
      assert.ok(result);
      assert.equal(result.length, 1);
      assert.equal(result[0].file.name, 'ok.ifc');
    });

    // Boundary test: the picker's accept filter (what the Chromium Open
    // dialog will let the user select) against the ingest guard that every
    // load path routes through. Both ends were covered on their own — the
    // picker's return handling above, `isSupportedModelFile` at its call
    // sites — but nothing compared what the picker OFFERS against what the
    // app ACCEPTS, so `.ifczip` sat in the guard and not in the filter.
    it('offers every extension the ingest guard accepts', async () => {
      let offered: string[] = [];
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async (
        opts: { types?: FilePickerAcceptType[] },
      ) => {
        offered = (opts.types ?? []).flatMap((t) => Object.values(t.accept).flat());
        return [fakeHandle('a.ifc')];
      };
      await openIfcFilesWithHandles();

      for (const ext of MODEL_FILE_EXTENSIONS) {
        assert.ok(
          isSupportedModelFile(fakeFile(`model${ext}`)),
          `${ext} must be accepted by the ingest guard`,
        );
        assert.ok(
          offered.includes(ext),
          `the picker hides ${ext}, which the viewer can ingest — the user cannot select it`,
        );
      }
    });

    it('returns null (not an empty array) when every picked handle fails to read', async () => {
      const badHandle = fakeHandle('broken.ifc', {
        getFile: async () => {
          throw new Error('file moved');
        },
      });
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [badHandle];
      const result = await openIfcFilesWithHandles();
      assert.equal(result, null);
    });
  });

  describe('readFreshFile', () => {
    it('re-reads the file when the engine has no permission API (optimistic true)', async () => {
      const handle = fakeHandle('x.ifc');
      const file = await readFreshFile(handle as unknown as FileSystemFileHandle);
      assert.ok(file);
      assert.equal(file.name, 'x.ifc');
    });

    it('re-reads the file when permission is already granted', async () => {
      const handle = fakeHandle('x.ifc', {
        queryPermission: async () => 'granted',
      });
      const file = await readFreshFile(handle as unknown as FileSystemFileHandle);
      assert.ok(file);
    });

    it('returns null WITHOUT reading the file when permission is denied and cannot be re-requested', async () => {
      let getFileCalls = 0;
      const handle = fakeHandle('x.ifc', {
        queryPermission: async () => 'prompt',
        getFile: async () => {
          getFileCalls += 1;
          return fakeFile('x.ifc');
        },
      });
      const file = await readFreshFile(handle as unknown as FileSystemFileHandle);
      assert.equal(file, null);
      assert.equal(getFileCalls, 0, 'must not read the file when permission was not confirmed granted');
    });

    it('re-prompts via requestPermission and reads on grant', async () => {
      const handle = fakeHandle('x.ifc', {
        queryPermission: async () => 'prompt',
        requestPermission: async () => 'granted',
      });
      const file = await readFreshFile(handle as unknown as FileSystemFileHandle);
      assert.ok(file);
    });

    it('returns null when requestPermission is re-prompted and denied', async () => {
      let getFileCalls = 0;
      const handle = fakeHandle('x.ifc', {
        queryPermission: async () => 'prompt',
        requestPermission: async () => 'denied',
        getFile: async () => {
          getFileCalls += 1;
          return fakeFile('x.ifc');
        },
      });
      const file = await readFreshFile(handle as unknown as FileSystemFileHandle);
      assert.equal(file, null);
      assert.equal(getFileCalls, 0);
    });

    it('returns null when getFile() itself throws after permission was granted', async () => {
      const handle = fakeHandle('x.ifc', {
        queryPermission: async () => 'granted',
        getFile: async () => {
          throw new Error('moved/deleted');
        },
      });
      const file = await readFreshFile(handle as unknown as FileSystemFileHandle);
      assert.equal(file, null);
    });
  });

  describe('handlesFromDataTransfer', () => {
    function fakeDataTransfer(items: Array<{ kind: string; getAsFileSystemHandle?: () => Promise<unknown> }>) {
      return { items } as unknown as DataTransfer;
    }

    it('resolves null when the API is unavailable', async () => {
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
      const dt = fakeDataTransfer([{ kind: 'file', getAsFileSystemHandle: async () => fakeHandle('a.ifc') }]);
      const result = await handlesFromDataTransfer(dt);
      assert.equal(result, null);
    });

    it('resolves null when there are no file-kind items (e.g. only text/plain)', async () => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [];
      const dt = fakeDataTransfer([{ kind: 'string' }]);
      const result = await handlesFromDataTransfer(dt);
      assert.equal(result, null);
    });

    it('resolves null when the browser does not expose getAsFileSystemHandle', async () => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [];
      const dt = fakeDataTransfer([{ kind: 'file' }]);
      const result = await handlesFromDataTransfer(dt);
      assert.equal(result, null);
    });

    it('returns handles for dropped files, skipping non-file kinds', async () => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [];
      const dt = fakeDataTransfer([
        { kind: 'file', getAsFileSystemHandle: async () => fakeHandle('dropped.ifc') },
        { kind: 'string' },
      ]);
      const result = await handlesFromDataTransfer(dt);
      assert.ok(result);
      assert.equal(result.length, 1);
      assert.equal(result[0].file.name, 'dropped.ifc');
    });

    it('skips a dropped item whose handle is a directory, not a file', async () => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [];
      const dirHandle = { name: 'folder', kind: 'directory' };
      const dt = fakeDataTransfer([{ kind: 'file', getAsFileSystemHandle: async () => dirHandle }]);
      const result = await handlesFromDataTransfer(dt);
      assert.equal(result, null);
    });
  });
});
