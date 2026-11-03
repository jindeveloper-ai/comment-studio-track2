import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { defaultBrowser, requireAutomation } from './default-browser.js';
import {
  closeManagedProfile,
  inspectManagedProfile,
} from './managed-browser.js';
import { AppError } from './safety.js';

export const YOUTUBE_LOGIN_URL =
  'https://www.youtube.com/channel_switcher?hl=ko';

export function profileInUse(directory: string): boolean {
  try {
    const target = readlinkSync(join(directory, 'SingletonLock'));
    const pid = /-(\d+)$/.exec(target)?.[1];
    if (!pid) return true;
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'EINVAL';
  }
}

export function loginArguments(directory: string): string[] {
  // Launch the installed browser normally. No automation, debugging, or fingerprint overrides.
  return [
    `--user-data-dir=${directory}`,
    '--lang=ko-KR',
    '--no-first-run',
    '--new-window',
    YOUTUBE_LOGIN_URL,
  ];
}

export function loginCommand(
  executable: string,
  directory: string,
  platform: string,
) {
  const args = loginArguments(directory);
  if (platform !== 'darwin') return { command: executable, args };
  const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1];
  if (!bundle)
    throw new AppError(
      'BROWSER_APP',
      '기본 브라우저의 macOS 앱 위치를 확인하지 못했습니다.',
    );
  // LaunchServices registers and foregrounds the new app instance. -W tracks its
  // lifetime; killing this launcher would not close the browser or flush cookies.
  return {
    command: '/usr/bin/open',
    args: ['-n', '-W', '-a', bundle, '--args', ...args],
  };
}

interface LoginRuntime {
  executable: () => string | Promise<string>;
  launch: (command: string, args: string[]) => ChildProcess;
  inUse: (directory: string) => boolean;
  closeTimeout: number;
  platform: string;
  reopen: (executable: string, directory: string) => Promise<void>;
  closeManaged: (executable: string, directory: string) => Promise<boolean>;
}

export class ManualLogin {
  private processes = new Map<string, ChildProcess>();
  private starting = new Set<string>();
  private runtime: LoginRuntime;
  constructor(runtime: Partial<LoginRuntime> = {}) {
    const platform = runtime.platform || process.platform;
    this.runtime = {
      executable: async () => requireAutomation(await defaultBrowser.resolve()),
      launch: (command, args) =>
        spawn(command, args, { shell: false, detached: true, stdio: 'ignore' }),
      inUse: profileInUse,
      closeTimeout: 10000,
      platform,
      closeManaged: closeManagedProfile,
      reopen: async (executable, directory) => {
        if (platform === 'darwin') {
          const browser = await inspectManagedProfile(executable, directory);
          if (!browser || browser.automated)
            throw new AppError(
              'PROFILE_IN_USE',
              '로그인 창을 다시 표시할 수 없습니다. 해당 전용 브라우저를 완전히 종료한 뒤 다시 열어 주세요.',
              409,
            );
        }
        const invocation = loginCommand(executable, directory, platform);
        try {
          await promisify(execFile)(
            invocation.command,
            invocation.args.filter((arg) => arg !== '-W'),
            { timeout: 5000, maxBuffer: 1024 },
          );
        } catch {
          throw new AppError(
            'BROWSER_OPEN',
            '로그인 창을 다시 표시하지 못했습니다. 해당 전용 창을 종료한 뒤 다시 열어 주세요.',
          );
        }
      },
      ...runtime,
    };
  }

  assertAvailable(directory: string) {
    if (this.runtime.inUse(directory))
      throw new AppError(
        'PROFILE_IN_USE',
        '이 전용 프로필의 브라우저가 아직 열려 있습니다. 로그인 창을 완전히 종료한 뒤 연결해 주세요.',
        409,
      );
  }

  async start(
    id: string,
    directory: string,
    executable?: string,
  ): Promise<void> {
    if (this.starting.has(id))
      throw new AppError(
        'PROFILE_BUSY',
        '로그인용 기본 브라우저를 여는 중입니다.',
        409,
      );
    this.starting.add(id);
    try {
      const selected = executable || (await this.runtime.executable());
      const previous = this.processes.get(id);
      if (
        (previous &&
          previous.exitCode === null &&
          previous.signalCode === null) ||
        (this.runtime.platform === 'darwin' && this.runtime.inUse(directory))
      ) {
        await this.runtime.reopen(selected, directory);
        return;
      }
      this.assertAvailable(directory);
      const invocation = loginCommand(
        selected,
        directory,
        this.runtime.platform,
      );
      const child = this.runtime.launch(invocation.command, invocation.args);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', () =>
          reject(
            new AppError(
              'BROWSER_OPEN',
              '로그인용 기본 브라우저를 열지 못했습니다. 설치 상태를 확인해 주세요.',
            ),
          ),
        );
      });
      this.processes.set(id, child);
      child.once('exit', () => {
        if (this.processes.get(id) === child) this.processes.delete(id);
      });
      child.unref();
      if (this.runtime.platform === 'darwin') {
        const until = Date.now() + 5000;
        while (
          !this.runtime.inUse(directory) &&
          child.exitCode === null &&
          Date.now() < until
        )
          await delay(100);
        if (!this.runtime.inUse(directory))
          throw new AppError(
            'BROWSER_NOT_READY',
            '전용 브라우저 시작을 확인하지 못했습니다. 잠시 후 다시 열어 주세요.',
          );
      }
    } finally {
      this.starting.delete(id);
    }
  }

  async finish(
    id: string,
    directory: string,
    executable?: string,
  ): Promise<void> {
    if (this.starting.has(id))
      throw new AppError(
        'PROFILE_BUSY',
        '로그인 창을 여는 중입니다. 잠시 기다려 주세요.',
        409,
      );
    const child = this.processes.get(id);
    if (this.runtime.platform === 'darwin') {
      // open -W can outlive a closed browser. The profile lock is authoritative.
      if (this.runtime.inUse(directory)) {
        const closed = await this.runtime.closeManaged(
          executable || (await this.runtime.executable()),
          directory,
        );
        if (!closed)
          throw new AppError(
            'LOGIN_WINDOW_OPEN',
            '전용 로그인 창인지 안전하게 확인하지 못했습니다. 로그인한 전용 창만 ⌘Q로 종료한 뒤 다시 연결해 주세요.',
            409,
          );
        const until = Date.now() + this.runtime.closeTimeout;
        while (this.runtime.inUse(directory) && Date.now() < until)
          await delay(100);
        this.assertAvailable(directory);
      }
      this.processes.delete(id);
      return;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      // Windows SIGTERM interrupts persistence. On macOS the child is the OS
      // launcher, not the browser; the user must quit the dedicated app instance.
      if (this.runtime.platform === 'win32')
        throw new AppError(
          'LOGIN_WINDOW_OPEN',
          '로그인을 마친 전용 브라우저 창을 완전히 종료한 뒤 다시 연결해 주세요.',
          409,
        );
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.off('exit', exited);
        };
        const exited = () => {
          cleanup();
          resolve();
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new AppError(
              'LOGIN_WINDOW_OPEN',
              '로그인용 브라우저 종료를 기다리고 있습니다. 해당 창을 완전히 종료하고 다시 연결해 주세요.',
              409,
            ),
          );
        }, this.runtime.closeTimeout);
        child.once('exit', exited);
        if (!child.kill('SIGTERM') && child.exitCode !== null) exited();
      });
      this.processes.delete(id);
      // Wait for Chrome to finish flushing cookies and release its own profile lock.
      for (let i = 0; i < 20 && this.runtime.inUse(directory); i++)
        await delay(100);
    }
    this.assertAvailable(directory);
  }
}
