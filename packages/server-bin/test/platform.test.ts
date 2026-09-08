/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn((_cmd: string, _opts?: unknown) => 'ldd (GNU libc) 2.39'));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

import { getPlatformInfo, getPlatformDescription, type PlatformInfo } from '../src/platform.js';

const realPlatform = process.platform;
const realArch = process.arch;

function setEnvironment(platform: string, arch: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

beforeEach(() => {
  execSyncMock.mockReset();
  execSyncMock.mockReturnValue('ldd (GNU libc) 2.39');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

describe('getPlatformInfo - supported targets', () => {
  it('describes macOS arm64 as a tar.gz target with an extension-less binary', () => {
    setEnvironment('darwin', 'arm64');
    const info = getPlatformInfo();
    expect(info.platform).toBe('darwin');
    expect(info.arch).toBe('arm64');
    expect(info.targetTriple).toBe('darwin-arm64');
    expect(info.archiveType).toBe('tar.gz');
    expect(info.archiveName).toBe('ifc-lite-server-darwin-arm64.tar.gz');
    expect(info.binaryName).toBe('ifc-lite-server');
    expect(info.isMusl).toBe(false);
  });

  it('describes macOS x64', () => {
    setEnvironment('darwin', 'x64');
    expect(getPlatformInfo().archiveName).toBe('ifc-lite-server-darwin-x64.tar.gz');
  });

  it('gives Windows a .exe binary name and a zip archive', () => {
    setEnvironment('win32', 'x64');
    const info = getPlatformInfo();
    expect(info.binaryName).toBe('ifc-lite-server.exe');
    expect(info.archiveType).toBe('zip');
    expect(info.archiveName).toBe('ifc-lite-server-win32-x64.zip');
  });

  it('never appends .exe or zip on non-Windows platforms', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64']] as const) {
      setEnvironment(platform, arch);
      const info = getPlatformInfo();
      expect(info.binaryName).toBe('ifc-lite-server');
      expect(info.binaryName.endsWith('.exe')).toBe(false);
      expect(info.archiveType).toBe('tar.gz');
    }
  });

  it('detects glibc Linux x64 as a non-musl target', () => {
    setEnvironment('linux', 'x64');
    const info = getPlatformInfo();
    expect(info.isMusl).toBe(false);
    expect(info.targetTriple).toBe('linux-x64');
    expect(info.archiveName).toBe('ifc-lite-server-linux-x64.tar.gz');
  });

  it('detects musl Linux x64 and appends the -musl suffix to triple and archive', () => {
    setEnvironment('linux', 'x64');
    execSyncMock.mockReturnValue('musl libc (x86_64)\nVersion 1.2.5');
    const info = getPlatformInfo();
    expect(info.isMusl).toBe(true);
    expect(info.targetTriple).toBe('linux-x64-musl');
    expect(info.archiveName).toBe('ifc-lite-server-linux-x64-musl.tar.gz');
  });

  it('matches musl case-insensitively', () => {
    setEnvironment('linux', 'x64');
    execSyncMock.mockReturnValue('MUSL libc (x86_64)');
    expect(getPlatformInfo().isMusl).toBe(true);
  });

  it('treats an unreadable ldd (throwing execSync) as glibc rather than failing', () => {
    setEnvironment('linux', 'x64');
    execSyncMock.mockImplementation(() => {
      throw new Error('ldd: not found');
    });
    const info = getPlatformInfo();
    expect(info.isMusl).toBe(false);
    expect(info.targetTriple).toBe('linux-x64');
  });

  it('does not probe ldd at all on non-Linux platforms', () => {
    setEnvironment('darwin', 'arm64');
    getPlatformInfo();
    expect(execSyncMock).not.toHaveBeenCalled();

    setEnvironment('win32', 'x64');
    getPlatformInfo();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('probes ldd exactly once on Linux', () => {
    setEnvironment('linux', 'arm64');
    getPlatformInfo();
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(String(execSyncMock.mock.calls[0]?.[0])).toContain('ldd');
  });
});

describe('getPlatformInfo - rejected targets', () => {
  it('rejects an unsupported platform naming it', () => {
    setEnvironment('freebsd', 'x64');
    expect(() => getPlatformInfo()).toThrow(/Unsupported platform: freebsd/);
  });

  it('rejects an unsupported architecture naming it', () => {
    setEnvironment('linux', 'ia32');
    expect(() => getPlatformInfo()).toThrow(/Unsupported architecture: ia32/);
  });

  it('rejects a supported platform crossed with an unsupported arch before the triple check', () => {
    setEnvironment('darwin', 'riscv64');
    expect(() => getPlatformInfo()).toThrow(/Unsupported architecture/);
  });

  it('rejects Windows on arm64 - a valid platform and a valid arch, but no released target', () => {
    setEnvironment('win32', 'arm64');
    expect(() => getPlatformInfo()).toThrow(/Unsupported platform\/architecture combination: win32-arm64/);
  });

  it('rejects musl Linux on arm64 - no musl arm64 build is published', () => {
    setEnvironment('linux', 'arm64');
    execSyncMock.mockReturnValue('musl libc (aarch64)');
    expect(() => getPlatformInfo()).toThrow(/Unsupported platform\/architecture combination: linux-arm64-musl/);
  });

  it('accepts glibc Linux arm64 - the non-musl counterpart of the rejected case', () => {
    setEnvironment('linux', 'arm64');
    expect(getPlatformInfo().targetTriple).toBe('linux-arm64');
  });

  it('lists the supported targets in the combination error', () => {
    setEnvironment('win32', 'arm64');
    expect(() => getPlatformInfo()).toThrow(/darwin-x64, darwin-arm64, linux-x64, linux-arm64, linux-x64-musl, win32-x64/);
  });
});

describe('getPlatformDescription', () => {
  const base: PlatformInfo = {
    platform: 'linux',
    arch: 'x64',
    binaryName: 'ifc-lite-server',
    archiveName: 'ifc-lite-server-linux-x64.tar.gz',
    archiveType: 'tar.gz',
    targetTriple: 'linux-x64',
    isMusl: false,
  };

  it('renders human names per platform', () => {
    expect(getPlatformDescription({ ...base, platform: 'darwin' })).toContain('macOS');
    expect(getPlatformDescription({ ...base, platform: 'linux' })).toContain('Linux');
    expect(getPlatformDescription({ ...base, platform: 'win32' })).toContain('Windows');
  });

  it('renders human names per architecture', () => {
    expect(getPlatformDescription({ ...base, arch: 'x64' })).toContain('x64 (Intel/AMD)');
    expect(getPlatformDescription({ ...base, arch: 'arm64' })).toContain('ARM64 (Apple Silicon/ARM)');
  });

  it('appends the musl suffix only when isMusl is true', () => {
    expect(getPlatformDescription({ ...base, isMusl: true })).toBe('Linux x64 (Intel/AMD) (musl/Alpine)');
    expect(getPlatformDescription({ ...base, isMusl: false })).toBe('Linux x64 (Intel/AMD)');
  });
});
