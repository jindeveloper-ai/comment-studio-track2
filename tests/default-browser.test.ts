import { describe, expect, it, vi } from 'vitest';
import {
  DefaultBrowser,
  detectDefaultBrowser,
  openDefaultUrl,
  requireAutomation,
} from '../src/server/default-browser.js';

describe('system default browser detection', () => {
  it('resolves the macOS HTTPS default and its actual app executable', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.at(-1)?.endsWith('Info.plist'))
        return JSON.stringify({
          CFBundleIdentifier: 'com.microsoft.edgemac',
          CFBundleExecutable: 'Microsoft Edge',
        });
      return JSON.stringify({
        LSHandlers: [
          { LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.google.chrome' },
          {
            LSHandlerURLScheme: 'https',
            LSHandlerRoleAll: 'com.microsoft.edgemac',
          },
        ],
      });
    });
    const browser = await detectDefaultBrowser({
      platform: 'darwin',
      home: '/users/reviewer',
      run,
      exists: (p) => p.startsWith('/Applications/'),
    });
    expect(browser).toMatchObject({
      family: 'edge',
      executable:
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    });
    expect(run).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['set']),
    );
  });
  it('rejects mismatched macOS app metadata', async () => {
    await expect(
      detectDefaultBrowser({
        platform: 'darwin',
        home: '/user',
        exists: () => true,
        run: async (_c, args) =>
          args.at(-1)?.endsWith('Info.plist')
            ? JSON.stringify({
                CFBundleIdentifier: 'different',
                CFBundleExecutable: 'Chrome',
              })
            : JSON.stringify({
                LSHandlers: [
                  {
                    LSHandlerURLScheme: 'https',
                    LSHandlerRoleAll: 'com.google.chrome',
                  },
                ],
              }),
      }),
    ).rejects.toThrow('mismatch');
  });
  it('reads Windows HTTPS UserChoice and preserves executable paths with spaces', async () => {
    const run = vi.fn(async (_c: string, args: string[]) =>
      args.includes('/v')
        ? '    ProgId    REG_SZ    MSEdgeHTM'
        : '    (Default)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1',
    );
    const browser = await detectDefaultBrowser({
      platform: 'win32',
      run,
      exists: () => true,
    });
    expect(requireAutomation(browser)).toBe(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    );
    expect(
      run.mock.calls.every(
        ([command, args]) => command === 'reg.exe' && args[0] === 'query',
      ),
    ).toBe(true);
  });
  it('does not interpret registry command arguments as shell commands', async () => {
    const browser = await detectDefaultBrowser({
      platform: 'win32',
      exists: () => true,
      run: async (_c, args) =>
        args.includes('/v')
          ? ' ProgId REG_SZ ChromeHTML'
          : ' (Default) REG_SZ "C:\\Chrome\\chrome.exe" "$(private)" & something',
    });
    expect(browser.executable).toBe('C:\\Chrome\\chrome.exe');
  });
  it('resolves a Linux desktop association through XDG paths', async () => {
    const browser = await detectDefaultBrowser({
      platform: 'linux',
      home: '/user',
      env: {
        PATH: '/usr/bin',
        XDG_DATA_HOME: '/user/data',
        XDG_DATA_DIRS: '/usr/share',
      },
      run: async () => 'google-chrome.desktop',
      exists: (p) =>
        p === '/user/data/applications/google-chrome.desktop' ||
        p === '/usr/bin/google-chrome',
      read: () =>
        '[Desktop Entry]\nName=Chrome\nExec=google-chrome --new-window %U\n[Desktop Action New]\nExec=other',
    });
    expect(requireAutomation(browser)).toBe('/usr/bin/google-chrome');
  });
  it('rejects Linux wrapper launchers rather than guessing another browser', async () => {
    await expect(
      detectDefaultBrowser({
        platform: 'linux',
        home: '/user',
        env: { PATH: '/usr/bin' },
        run: async () => 'google-chrome.desktop',
        exists: () => true,
        read: () => '[Desktop Entry]\nExec=env FLAG=value google-chrome %U\n',
      }),
    ).rejects.toThrow('unsupported');
  });
  it('keeps Safari as default without silently falling back to Chrome', async () => {
    const browser = await detectDefaultBrowser({
      platform: 'darwin',
      run: async () =>
        JSON.stringify({
          LSHandlers: [
            {
              LSHandlerURLScheme: 'https',
              LSHandlerRoleAll: 'com.apple.Safari',
            },
          ],
        }),
    });
    expect(browser.name).toBe('Safari');
    expect(() => requireAutomation(browser)).toThrow('Safari');
    const resolver = new DefaultBrowser(async () => browser);
    expect(await resolver.refresh()).toMatchObject({
      name: 'Safari',
      automation: false,
    });
  });
  it('reports a failed detection without returning raw OS errors or paths', async () => {
    const resolver = new DefaultBrowser(async () => {
      throw new Error('/private/diagnostic');
    });
    const status = await resolver.refresh();
    expect(status.automation).toBe(false);
    expect(JSON.stringify(status)).not.toContain('private');
    expect(JSON.stringify(status)).not.toContain('executable');
  });
  it('rejects arbitrary browser URLs before running an OS opener', async () => {
    await expect(
      openDefaultUrl('file:///private/credentials'),
    ).rejects.toMatchObject({ code: 'BROWSER_URL' });
    await expect(
      openDefaultUrl('https://untrusted.test'),
    ).rejects.toMatchObject({ code: 'BROWSER_URL' });
  });
});
