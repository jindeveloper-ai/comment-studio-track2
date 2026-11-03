import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loginArguments,
  loginCommand,
  ManualLogin,
  profileInUse,
} from '../src/server/manual-login.js';

function fakeChild() {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    exitCode: null as number | null,
    signalCode: null as string | null,
    unref: vi.fn(),
    kill: vi.fn((signal: string) => {
      child.signalCode = signal;
      emitter.emit('exit', null, signal);
      return true;
    }),
  });
  return child;
}
function fixture() {
  const child = fakeChild();
  const reopen = vi.fn().mockResolvedValue(undefined);
  const launch = vi.fn(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  });
  const login = new ManualLogin({
    executable: () => '/installed/google-chrome',
    launch,
    inUse: () => false,
    platform: 'linux',
    reopen,
  });
  return { child, launch, login, reopen };
}
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('manual Google login lifecycle', () => {
  it('opens normal Chrome without automation, debugging, or security overrides', async () => {
    const { login, launch } = fixture();
    await login.start('youtube1', '/local/profile with spaces');
    expect(launch).toHaveBeenCalledWith(
      '/installed/google-chrome',
      loginArguments('/local/profile with spaces'),
    );
    const args = launch.mock.calls[0] as unknown as [string, string[]];
    expect(args[1]).toContain('--user-data-dir=/local/profile with spaces');
    expect(args[1].join(' ')).not.toMatch(
      /automation|remote-debugging|disable|headless|user-agent|ignore-certificate/,
    );
    expect(args[1].at(-1)).toBe(
      'https://www.youtube.com/channel_switcher?hl=ko',
    );
  });
  it('reopens the existing login window without losing ownership of the original process', async () => {
    const { login, launch, reopen, child } = fixture();
    await login.start('youtube1', '/profile');
    await login.start('youtube1', '/profile');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith('/installed/google-chrome', '/profile');
    await login.finish('youtube1', '/profile');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('closes only its own login process gracefully before handing over the same directory', async () => {
    const { login, child } = fixture();
    await login.start('youtube1', '/profile');
    await login.finish('youtube1', '/profile');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it('does not terminate untracked Chrome instances or remove profile locks', async () => {
    const { child } = fixture();
    const login = new ManualLogin({ platform: 'linux', inUse: () => true });
    await expect(login.finish('youtube1', '/profile')).rejects.toMatchObject({
      code: 'PROFILE_IN_USE',
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('blocks an unclosed profile before spawning another browser', async () => {
    const launch = vi.fn();
    const login = new ManualLogin({
      platform: 'linux',
      executable: () => '/chrome',
      inUse: () => true,
      launch,
    });
    await expect(login.start('youtube1', '/profile')).rejects.toMatchObject({
      code: 'PROFILE_IN_USE',
    });
    expect(launch).not.toHaveBeenCalled();
  });
  it('does not echo raw process errors', async () => {
    const child = fakeChild();
    const login = new ManualLogin({
      platform: 'linux',
      executable: () => '/chrome',
      inUse: () => false,
      launch: () => {
        queueMicrotask(() =>
          child.emit('error', new Error('private diagnostic')),
        );
        return child as unknown as ChildProcess;
      },
    });
    await expect(login.start('youtube1', '/profile')).rejects.toMatchObject({
      code: 'BROWSER_OPEN',
    });
  });
  it('launches a visible macOS app instance through LaunchServices with the isolated profile', () => {
    const command = loginCommand(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/profile with spaces',
      'darwin',
    );
    expect(command.command).toBe('/usr/bin/open');
    expect(command.args.slice(0, 5)).toEqual([
      '-n',
      '-W',
      '-a',
      '/Applications/Google Chrome.app',
      '--args',
    ]);
    expect(command.args).toContain('--user-data-dir=/profile with spaces');
    expect(command.args).not.toContain('-g');
    expect(command.args).not.toContain('-j');
    expect(command.args.join(' ')).not.toMatch(
      /remote-debugging|automation|disable-web-security/,
    );
  });
  it('ignores a stale macOS launcher after the browser has already released its profile', async () => {
    const child = fakeChild();
    let active = false;
    const login = new ManualLogin({
      platform: 'darwin',
      executable: () =>
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      inUse: () => active,
      launch: () => {
        active = true;
        queueMicrotask(() => child.emit('spawn'));
        return child as unknown as ChildProcess;
      },
    });
    await login.start('youtube1', '/profile');
    active = false;
    await expect(login.finish('youtube1', '/profile')).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('safely closes a verified macOS profile after a server restart without signaling the OS launcher', async () => {
    let active = true;
    const closeManaged = vi.fn(async () => {
      active = false;
      return true;
    });
    const login = new ManualLogin({
      platform: 'darwin',
      executable: () => '/chrome',
      inUse: () => active,
      closeManaged,
    });
    await login.finish('youtube1', '/managed/profile');
    expect(closeManaged).toHaveBeenCalledWith('/chrome', '/managed/profile');
  });
  it('refuses to close a macOS process whose managed profile cannot be verified', async () => {
    const closeManaged = vi.fn().mockResolvedValue(false);
    const login = new ManualLogin({
      platform: 'darwin',
      executable: () => '/chrome',
      inUse: () => true,
      closeManaged,
    });
    await expect(
      login.finish('youtube1', '/managed/profile'),
    ).rejects.toMatchObject({ code: 'LOGIN_WINDOW_OPEN' });
  });
  it('reopens a managed macOS window even after the server has lost the launcher record', async () => {
    const reopen = vi.fn().mockResolvedValue(undefined);
    const launch = vi.fn();
    const login = new ManualLogin({
      platform: 'darwin',
      executable: () => '/chrome',
      inUse: () => true,
      reopen,
      launch,
    });
    await login.start('youtube1', '/managed/profile');
    expect(reopen).toHaveBeenCalledWith('/chrome', '/managed/profile');
    expect(launch).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')(
    'detects an active lock without reading cookies or credentials',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'studio-login-'));
      dirs.push(dir);
      expect(profileInUse(dir)).toBe(false);
      symlinkSync(`local-${process.pid}`, join(dir, 'SingletonLock'));
      expect(profileInUse(dir)).toBe(true);
    },
  );
  it('asks the user to close Windows login normally instead of terminating it', async () => {
    const child = fakeChild();
    const login = new ManualLogin({
      platform: 'win32',
      executable: () => 'C:\\Edge\\msedge.exe',
      inUse: () => false,
      launch: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child as unknown as ChildProcess;
      },
    });
    await login.start('youtube1', '/profile');
    await expect(login.finish('youtube1', '/profile')).rejects.toMatchObject({
      code: 'LOGIN_WINDOW_OPEN',
    });
    expect(child.kill).not.toHaveBeenCalled();
  });
});
