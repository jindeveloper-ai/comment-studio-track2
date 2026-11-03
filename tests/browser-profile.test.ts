import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  launch: vi.fn(),
  login: vi.fn(),
  finish: vi.fn(),
  directory: '',
}));
vi.mock('playwright', () => ({
  chromium: { launchPersistentContext: harness.launch },
}));
vi.mock('../src/server/config.js', () => ({
  config: {
    get dataDir() {
      return harness.directory;
    },
  },
}));
vi.mock('../src/server/manual-login.js', () => ({
  ManualLogin: class {
    assertAvailable() {}
    start = harness.login;
    finish = harness.finish;
  },
}));

import { BrowserService } from '../src/server/browser.js';
import {
  DefaultBrowser,
  type DetectedBrowser,
} from '../src/server/default-browser.js';
import { Store } from '../src/server/store.js';

afterEach(() => {
  if (harness.directory)
    rmSync(harness.directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
it('prevents recovery and posting during a profile connection and releases the lock after failure', async () => {
  harness.directory = mkdtempSync(join(tmpdir(), 'studio-connect-lock-'));
  const store = new Store(':memory:');
  const resolver = new DefaultBrowser(async () => ({
    id: 'com.google.chrome',
    name: 'Google Chrome',
    family: 'chrome',
    executable: '/chrome',
  }));
  const browser = new BrowserService(store, () => {}, resolver);
  const deferred = { reject: () => {} };
  const pending = new Promise<void>((_resolve, reject) => {
    deferred.reject = () => reject(new Error('fixture window still open'));
  });
  harness.finish.mockReturnValueOnce(pending);
  const checking = browser.check('youtube1');
  try {
    expect(() => browser.assertPostingAvailable()).toThrow();
    await expect(browser.openForLogin('youtube1', true)).rejects.toMatchObject({
      code: 'PROFILE_BUSY',
    });
    deferred.reject();
    await expect(checking).rejects.toMatchObject({
      code: 'PROFILE_CHECK_FAILED',
    });
    await browser.openForLogin('youtube1', true);
    expect(harness.login).toHaveBeenCalledTimes(1);
    expect(store.jobs()).toHaveLength(0);
  } finally {
    deferred.reject();
    await checking.catch(() => {});
    store.close();
  }
});
it('recovers with fresh cookies while preserving old data and reusing the selected session after restart', async () => {
  harness.directory = mkdtempSync(join(tmpdir(), 'studio-recovery-'));
  const store = new Store(':memory:');
  const resolver = new DefaultBrowser(async () => ({
    id: 'com.google.chrome',
    name: 'Google Chrome',
    family: 'chrome',
    executable: '/chrome',
  }));
  const browser = new BrowserService(store, () => {}, resolver);
  const previous = join(harness.directory, 'profiles', 'youtube1');
  mkdirSync(previous, { recursive: true });
  writeFileSync(join(previous, 'preserve.txt'), 'test fixture');
  const page = { goto: vi.fn(), bringToFront: vi.fn() };
  harness.launch.mockResolvedValue({
    pages: () => [page],
    on: vi.fn(),
    close: vi.fn(),
  });
  try {
    await browser.openForLogin('youtube1', true);
    const [key, directory, executable] = harness.login.mock.calls[0];
    expect(key).toBe(directory);
    expect(executable).toBe('/chrome');
    expect(directory).not.toBe(previous);
    expect(directory).toContain(join('profiles', 'sessions'));
    expect(existsSync(join(previous, 'preserve.txt'))).toBe(true);
    expect(store.profiles()[0].ready).toBe(false);
    expect(store.jobs()).toHaveLength(0);
    const restarted = new BrowserService(store, () => {}, resolver);
    await restarted.open('youtube1');
    expect(harness.launch.mock.calls[0][0]).toBe(directory);
    await restarted.close();
  } finally {
    store.close();
  }
});
it('keeps the selected session when a fresh browser launch fails', async () => {
  harness.directory = mkdtempSync(join(tmpdir(), 'studio-recovery-fail-'));
  const store = new Store(':memory:');
  const resolver = new DefaultBrowser(async () => ({
    id: 'com.google.chrome',
    name: 'Google Chrome',
    family: 'chrome',
    executable: '/chrome',
  }));
  const browser = new BrowserService(store, () => {}, resolver);
  try {
    await browser.openForLogin('youtube1', true);
    const previous = harness.login.mock.calls[0][1];
    harness.login.mockRejectedValueOnce(new Error('fixture launch failure'));
    await expect(browser.openForLogin('youtube1', true)).rejects.toThrow(
      'fixture launch failure',
    );
    await browser.openForLogin('youtube1');
    expect(harness.login.mock.calls[2][1]).toBe(previous);
  } finally {
    store.close();
  }
});
it('rejects concurrent recovery requests for the same profile', async () => {
  harness.directory = mkdtempSync(join(tmpdir(), 'studio-recovery-lock-'));
  const store = new Store(':memory:');
  const resolver = new DefaultBrowser(async () => ({
    id: 'com.google.chrome',
    name: 'Google Chrome',
    family: 'chrome',
    executable: '/chrome',
  }));
  const browser = new BrowserService(store, () => {}, resolver);
  const deferred = { resolve: () => {} };
  const pending = new Promise<void>((resolve) => {
    deferred.resolve = resolve;
  });
  harness.login.mockReturnValueOnce(pending);
  const first = browser.openForLogin('youtube1', true);
  try {
    await expect(browser.openForLogin('youtube1', true)).rejects.toMatchObject({
      code: 'PROFILE_BUSY',
    });
  } finally {
    deferred.resolve();
    await first;
    store.close();
  }
  expect(harness.login).toHaveBeenCalledTimes(1);
});
it('reuses the manually signed-in profile with the OS keychain without hiding automation', async () => {
  harness.directory = mkdtempSync(join(tmpdir(), 'studio-profile-'));
  const store = new Store(':memory:');
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    bringToFront: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    pages: () => [page],
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  harness.launch.mockResolvedValue(context);
  const resolver = new DefaultBrowser(async () => ({
    id: 'com.google.chrome',
    name: 'Google Chrome',
    family: 'chrome',
    executable: '/default/Google Chrome',
  }));
  const browser = new BrowserService(store, () => {}, resolver);
  try {
    await browser.open('youtube1');
    const [directory, options] = harness.launch.mock.calls[0];
    expect(directory).toBe(join(harness.directory, 'profiles', 'youtube1'));
    expect(options.executablePath).toBe('/default/Google Chrome');
    expect(options.channel).toBeUndefined();
    expect(options.ignoreDefaultArgs).toContain('--use-mock-keychain');
    expect(options.ignoreDefaultArgs).toContain('--password-store=basic');
    expect(options.ignoreDefaultArgs).not.toContain('--enable-automation');
    expect(options.args.join(' ')).not.toMatch(
      /AutomationControlled|disable-web-security|ignore-certificate/,
    );
    await browser.open('youtube1');
    expect(harness.launch).toHaveBeenCalledTimes(1);
  } finally {
    await browser.close();
    store.close();
  }
});
it('isolates profiles and clears readiness when the default browser changes', async () => {
  harness.directory = mkdtempSync(join(tmpdir(), 'studio-default-'));
  const store = new Store(':memory:');
  let selected: DetectedBrowser = {
    id: 'com.google.chrome',
    name: 'Google Chrome',
    family: 'chrome',
    executable: '/chrome',
  };
  const resolver = new DefaultBrowser(async () => selected);
  const browser = new BrowserService(store, () => {}, resolver);
  const page = { goto: vi.fn(), bringToFront: vi.fn() };
  harness.launch.mockResolvedValue({
    pages: () => [page],
    on: vi.fn(),
    close: vi.fn(),
  });
  try {
    store.setProfile('youtube1', true, 'UCconnected', 'test');
    await browser.refreshDefaultBrowser();
    expect(store.profiles()[0].ready).toBe(true);
    selected = {
      id: 'com.microsoft.edgemac',
      name: 'Microsoft Edge',
      family: 'edge',
      executable: '/edge',
    };
    await browser.refreshDefaultBrowser();
    expect(store.profiles()[0].ready).toBe(false);
    await browser.open('youtube1');
    const [directory, options] = harness.launch.mock.calls[0];
    expect(directory).not.toBe(join(harness.directory, 'profiles', 'youtube1'));
    expect(options.executablePath).toBe('/edge');
  } finally {
    await browser.close();
    store.close();
  }
});
it('blocks unsupported default browsers before opening or reserving a post', async () => {
  const store = new Store(':memory:');
  const resolver = new DefaultBrowser(async () => ({
    id: 'firefox.desktop',
    name: 'Firefox',
    family: 'other',
    executable: null,
  }));
  const browser = new BrowserService(store, () => {}, resolver);
  try {
    await browser.refreshDefaultBrowser();
    await expect(browser.open('youtube1')).rejects.toMatchObject({
      code: 'DEFAULT_BROWSER_UNSUPPORTED',
    });
    expect(() => browser.assertPostingAvailable()).toThrow('Firefox');
    expect(harness.launch).not.toHaveBeenCalled();
    expect(store.jobs()).toHaveLength(0);
  } finally {
    store.close();
  }
});
