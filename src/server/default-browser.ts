import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { DefaultBrowserStatus } from '../shared.js';
import { AppError } from './safety.js';

const execute = promisify(execFile);
interface DetectionRuntime {
  platform: string;
  home: string;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  read: (path: string) => string;
  run: (command: string, args: string[]) => Promise<string>;
}
export interface DetectedBrowser {
  id: string;
  name: string;
  family: 'chrome' | 'edge' | 'chromium' | 'other';
  executable: string | null;
}
const runtime: DetectionRuntime = {
  platform: process.platform,
  home: homedir(),
  env: process.env,
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  run: async (command, args) =>
    (
      await execute(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 })
    ).stdout.trim(),
};
function identify(id: string): Pick<DetectedBrowser, 'name' | 'family'> {
  if (/chrome|ChromeHTML/i.test(id))
    return { name: 'Google Chrome', family: 'chrome' };
  if (/microsoft.*edge|msedge/i.test(id))
    return { name: 'Microsoft Edge', family: 'edge' };
  if (/chromium/i.test(id)) return { name: 'Chromium', family: 'chromium' };
  if (/safari/i.test(id)) return { name: 'Safari', family: 'other' };
  if (/firefox/i.test(id)) return { name: 'Firefox', family: 'other' };
  if (/brave/i.test(id)) return { name: 'Brave', family: 'other' };
  return { name: '기본 브라우저', family: 'other' };
}
function registryValue(
  output: string,
  type: 'REG_SZ' | 'REG_DWORD' = 'REG_SZ',
): string {
  return new RegExp(`\\s${type}\\s+(.+)`).exec(output)?.[1]?.trim() || '';
}

// Read OS associations only. Never change the user's default browser or use a personal profile.
export async function detectDefaultBrowser(
  overrides: Partial<DetectionRuntime> = {},
): Promise<DetectedBrowser> {
  const r = { ...runtime, ...overrides };
  if (r.platform === 'darwin') {
    const settings = JSON.parse(
      await r.run('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        join(
          r.home,
          'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
        ),
      ]),
    ) as {
      LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[];
    };
    const handlers = settings.LSHandlers || [];
    const id =
      handlers.find((h) => h.LSHandlerURLScheme === 'https')
        ?.LSHandlerRoleAll ||
      handlers.find((h) => h.LSHandlerURLScheme === 'http')?.LSHandlerRoleAll;
    if (!id || !/^[a-zA-Z0-9.-]+$/.test(id))
      throw new Error('default unavailable');
    const info = identify(id);
    if (info.family === 'other') return { id, ...info, executable: null };
    const names: Record<string, string> = {
      'com.google.chrome': 'Google Chrome',
      'com.google.chrome.beta': 'Google Chrome Beta',
      'com.google.chrome.canary': 'Google Chrome Canary',
      'com.microsoft.edgemac': 'Microsoft Edge',
      'com.microsoft.edgemac.beta': 'Microsoft Edge Beta',
      'com.microsoft.edgemac.dev': 'Microsoft Edge Dev',
      'org.chromium.chromium': 'Chromium',
    };
    const name = names[id.toLowerCase()];
    let bundle = name
      ? [
          join(r.home, 'Applications', `${name}.app`),
          `/Applications/${name}.app`,
        ].find(r.exists)
      : undefined;
    if (!bundle)
      bundle = (
        await r.run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${id}'`])
      )
        .split('\n')
        .find((p) => p.endsWith('.app') && r.exists(p));
    if (!bundle) throw new Error('browser unavailable');
    const metadata = JSON.parse(
      await r.run('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        join(bundle, 'Contents/Info.plist'),
      ]),
    ) as { CFBundleExecutable?: string; CFBundleIdentifier?: string };
    const binary = metadata.CFBundleExecutable;
    if (
      metadata.CFBundleIdentifier?.toLowerCase() !== id.toLowerCase() ||
      !binary ||
      /[/\\]/.test(binary)
    )
      throw new Error('browser mismatch');
    const executable = join(bundle, 'Contents/MacOS', binary);
    return {
      id,
      ...info,
      executable: r.exists(executable) ? executable : null,
    };
  }
  if (r.platform === 'win32') {
    const choice = await r.run('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
      '/v',
      'ProgId',
    ]);
    const id = registryValue(choice);
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('default unavailable');
    const info = identify(id);
    if (info.family === 'other') return { id, ...info, executable: null };
    const association = registryValue(
      await r.run('reg.exe', [
        'query',
        `HKCR\\${id}\\shell\\open\\command`,
        '/ve',
      ]),
    );
    const executable =
      /^"([^"]+\.exe)"/i.exec(association)?.[1] ||
      /^(\S+\.exe)(?:\s|$)/i.exec(association)?.[1];
    if (!executable || !win32.isAbsolute(executable))
      throw new Error('browser unavailable');
    return {
      id,
      ...info,
      executable: r.exists(executable) ? executable : null,
    };
  }
  if (r.platform === 'linux') {
    let id = await r
      .run('xdg-mime', ['query', 'default', 'x-scheme-handler/https'])
      .catch(() => '');
    if (!id) id = await r.run('xdg-settings', ['get', 'default-web-browser']);
    if (!/^[a-zA-Z0-9._-]+\.desktop$/.test(id))
      throw new Error('default unavailable');
    const info = identify(id);
    if (info.family === 'other') return { id, ...info, executable: null };
    const roots = [
      r.env.XDG_DATA_HOME || join(r.home, '.local/share'),
      ...(r.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'),
      '/var/lib/snapd/desktop',
    ];
    const desktop = roots
      .map((p) => join(p, 'applications', id))
      .find(r.exists);
    if (!desktop) throw new Error('browser unavailable');
    const entry =
      /(?:^|\n)\[Desktop Entry\]\r?\n([\s\S]*?)(?=\n\[|$)/.exec(
        r.read(desktop),
      )?.[1] || '';
    const command = /^Exec=(.+)$/m.exec(entry)?.[1]?.trim() || '';
    const binary =
      /^"([^"]+)"/.exec(command)?.[1] || /^(\S+)/.exec(command)?.[1];
    if (!binary || /[%$`]/.test(binary)) throw new Error('browser unavailable');
    const executable = isAbsolute(binary)
      ? binary
      : (r.env.PATH || '')
          .split(':')
          .map((p) => join(p, binary))
          .find(r.exists);
    // Wrapper launchers such as env/flatpak cannot safely share Playwright's executable arguments.
    if (
      !executable ||
      !/^(?:google-chrome(?:-stable|-beta|-unstable)?|chrome|chromium(?:-browser)?|microsoft-edge(?:-stable|-beta|-dev)?)$/.test(
        executable.split('/').at(-1) || '',
      )
    )
      throw new Error('browser launcher unsupported');
    return {
      id,
      ...info,
      executable: r.exists(executable) ? executable : null,
    };
  }
  throw new Error('OS unsupported');
}

export function requireAutomation(browser: DetectedBrowser): string {
  if (browser.family === 'other' || !browser.executable)
    throw new AppError(
      'DEFAULT_BROWSER_UNSUPPORTED',
      `${browser.name}에서는 전용 프로필 게시 자동화를 연결할 수 없습니다. 기본 브라우저를 Chrome 또는 Edge로 설정한 뒤 다시 감지해 주세요.`,
      409,
    );
  return browser.executable;
}

export class DefaultBrowser {
  current: DetectedBrowser = {
    id: 'unknown',
    name: '기본 브라우저 확인 전',
    family: 'other',
    executable: null,
  };
  private checkedAt: string | null = null;
  constructor(private detect = detectDefaultBrowser) {}
  async refresh(): Promise<DefaultBrowserStatus> {
    this.current = await this.detect().catch(() => ({
      id: 'unknown',
      name: '기본 브라우저 감지 실패',
      family: 'other' as const,
      executable: null,
    }));
    this.checkedAt = new Date().toISOString();
    return this.status();
  }
  async resolve(): Promise<DetectedBrowser> {
    if (!this.checkedAt) await this.refresh();
    return this.current;
  }
  status(): DefaultBrowserStatus {
    const automation =
      this.current.family !== 'other' && !!this.current.executable;
    return {
      name: this.current.name,
      platform: process.platform,
      automation,
      checkedAt: this.checkedAt,
      message: automation
        ? '로그인과 게시에 기본 브라우저의 전용 프로필을 사용합니다.'
        : '검수 페이지와 일반 YouTube는 기본 브라우저에서 열립니다. 전용 프로필 게시 연결은 Chrome · Edge · Chromium을 지원합니다.',
    };
  }
}

export const defaultBrowser = new DefaultBrowser();

export async function openDefaultUrl(url: string): Promise<void> {
  // Only application-owned loopback review pages and the fixed YouTube login URL.
  if (
    !/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url) &&
    url !== 'https://www.youtube.com/?hl=ko'
  )
    throw new AppError('BROWSER_URL', '열 수 없는 주소입니다.');
  try {
    if (process.platform === 'darwin')
      await runtime.run('/usr/bin/open', [url]);
    else if (process.platform === 'win32')
      await runtime.run('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
    else if (process.platform === 'linux') await runtime.run('xdg-open', [url]);
    else throw new Error('unsupported');
  } catch {
    throw new AppError(
      'DEFAULT_BROWSER_OPEN',
      '기본 브라우저를 열지 못했습니다. 화면의 로컬 주소로 직접 접속해 주세요.',
    );
  }
}
