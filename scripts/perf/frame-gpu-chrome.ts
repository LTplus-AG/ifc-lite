/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Windows Chrome lifecycle for the real-GPU frame rig (#6960), driven from
 * WSL. WSL's own Chromium only ever gets SwiftShader, so real-GPU frame time
 * needs the Windows browser: it is started with a random free CDP port and a
 * throwaway profile, reached over 127.0.0.1 (WSL mirrored networking works
 * both ways), and afterwards killed BY PROFILE PATH and its profile deleted,
 * because that profile caches model geometry.
 *
 * A fresh port per sample matters: a fixed port can reconnect to the previous,
 * not-yet-exited Chrome, whose profile still holds a warm cache.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

export function findWindowsChrome(override?: string | null): string {
  const found = [override, ...CHROME_CANDIDATES].find((path): path is string => Boolean(path) && existsSync(path!));
  if (!found) throw new Error('Windows Chrome not found; pass --chrome /mnt/c/.../chrome.exe');
  return found;
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.replace(/\r/g, '').trim();
}

/**
 * A random port nothing answers on at 127.0.0.1, below Windows' dynamic range.
 * Probed by CONNECTING, never by binding: under mirrored networking a port a
 * WSL process has just bound stays unavailable to Windows for a while, and
 * Chrome then silently never opens its DevTools endpoint.
 */
export async function randomUnusedPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 25000);
    const answered = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (!answered) return port;
  }
  throw new Error('no unused port found');
}

export interface WindowsChrome {
  cdpUrl: string;
  /** Windows path of the throwaway profile; the kill key. */
  profileWin: string;
  /** Kill every chrome.exe on this profile, then delete the profile. */
  dispose(): Promise<string | null>;
}

/**
 * Measured on this rig's host: roughly one fresh-profile launch in five never
 * opens its DevTools port (the browser process idles with only crashpad
 * beside it). A clean retry on a new port and profile recovers it.
 */
export async function launchWindowsChrome(exe: string, attempts = 3): Promise<WindowsChrome> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await launchOnce(exe);
    } catch (error) {
      lastError = error;
      console.error(`frame-gpu-chrome: launch attempt ${attempt}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError;
}

async function launchOnce(exe: string, windowSize = '1280,800'): Promise<WindowsChrome> {
  // %LOCALAPPDATA%, not %TEMP%: TEMP is often an 8.3 short path
  // (C:\Users\LOUIST~1\...), with which Chrome never opened its CDP port.
  const tempWin = `${run('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'])}\\Temp`;
  const profileWsl = join(run('wslpath', ['-u', tempWin]), `ifclite-frame-rig-${randomBytes(6).toString('hex')}`);
  mkdirSync(profileWsl, { recursive: true });
  const profileWin = run('wslpath', ['-w', profileWsl]);
  const port = await randomUnusedPort();
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileWin}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--enable-unsafe-webgpu', `--window-size=${windowSize}`, '--window-position=0,0',
    // Energy Saver caps rAF at ~30 fps on battery or when enabled; measured as
    // a flat 31.25 ms rAF delta before this was disabled.
    '--disable-features=BatterySaverModeAvailable,HighEfficiencyModeAvailable',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  const chrome: WindowsChrome = {
    cdpUrl: `http://127.0.0.1:${port}`,
    profileWin,
    async dispose() {
      // Match the full profile path, not "chrome.exe": other Chrome windows on
      // this machine are someone's browser, not ours to kill.
      const literal = profileWin.replace(/'/g, "''");
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { encoding: 'utf8' });
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          rmSync(profileWsl, { recursive: true, force: true });
          if (!existsSync(profileWsl)) return null;
        } catch (error) {
          if (attempt === 19) return `profile not deleted: ${profileWsl}: ${String(error)}`;
        }
        await sleep(500);
      }
      return `profile not deleted: ${profileWsl}`;
    },
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${chrome.cdpUrl}/json/version`);
      if (response.ok) return chrome;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error && error.cause ? `${error.message}: ${String(error.cause)}` : error; // not listening yet while Chrome starts; reported if it never does
    }
    await sleep(500);
  }
  await chrome.dispose();
  throw new Error(`Windows Chrome did not open CDP on ${chrome.cdpUrl}: ${String(lastError)}`);
}
