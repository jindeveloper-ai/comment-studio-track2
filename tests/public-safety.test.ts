import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  assertPublicFile,
  isPrivatePublicPath,
} from '../scripts/public-safety.js';

const directories: string[] = [];
const script = fileURLToPath(
  new URL('../scripts/check-public.mjs', import.meta.url),
);
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'studio-public-test-'));
  directories.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Safety test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'core.hooksPath', join(root, 'fixture-hooks')]);
  return root;
}
function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git fixture setup failed.');
}
function write(root: string, file: string, value: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), value);
}
function check(root: string, args = ['--staged'], env = process.env) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: result.status, output: result.stdout + result.stderr };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('protects environment files, browser sessions, backups and databases', () => {
  for (const file of [
    '.env',
    '.envrc',
    'production.env',
    'cookies.txt',
    'copy/.env.backup',
    '.local/profiles/youtube1/Default/Cookies',
    'copy/Local State',
    'storageState.json',
    'client_secret-copy.json',
    'studio.sqlite-wal',
    'backup.zip',
  ])
    expect(isPrivatePublicPath(file)).toBe(true);
  expect(isPrivatePublicPath('.env.example')).toBe(false);
  expect(isPrivatePublicPath('src/server/browser.ts')).toBe(false);
});
it('recognizes credentials and browser storage under innocent JSON filenames', () => {
  const fixtures = [
    { type: 'service_account' },
    { type: 'authorized_user' },
    { cookies: [], origins: [] },
    { os_crypt: {} },
    { account_info: [] },
    { refresh_token: ['fixture', 'value'].join('-') },
    { refreshToken: ['fixture', 'value'].join('-') },
    { encryptedPassword: ['fixture', 'value'].join('-') },
  ];
  for (const value of fixtures)
    expect(() =>
      assertPublicFile('settings.json', Buffer.from(JSON.stringify(value))),
    ).toThrow();
  expect(() =>
    assertPublicFile('package.json', Buffer.from('{"name":"example"}')),
  ).not.toThrow();
});
it('rejects renamed browser databases and archives', () => {
  expect(() =>
    assertPublicFile('copy.bin', Buffer.from('SQLite format 3\0fixture')),
  ).toThrow();
  expect(() =>
    assertPublicFile('copy.data', Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  ).toThrow();
});
it('keeps sensitive settings empty in the public environment example', () => {
  expect(() =>
    assertPublicFile(
      '.env.example',
      Buffer.from('GOOGLE_APPLICATION_CREDENTIALS=""\nPORT=3000'),
    ),
  ).not.toThrow();
  expect(() =>
    assertPublicFile('.env.example', Buffer.from('API_KEY=filled-example')),
  ).toThrow();
});
it('blocks force-added local environment files without echoing contents', () => {
  const root = repo();
  const value = ['fixture', 'private', 'not-for-output'].join('-');
  write(root, '.gitignore', '.env\n');
  write(root, '.env', value);
  git(root, ['add', '-f', '.env']);
  const result = check(root);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('protected_path');
  expect(result.output).not.toContain(value);
});
it('scans exact staged bytes even when the working file was replaced with a safe version', () => {
  const root = repo();
  write(root, 'settings.json', JSON.stringify({ type: 'service_account' }));
  git(root, ['add', 'settings.json']);
  write(root, 'settings.json', '{}');
  const result = check(root);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('authentication_json');
});
it('checks previous commits for local login data even if it was later deleted', () => {
  const root = repo();
  write(root, '.env', 'fixture');
  git(root, ['add', '.env']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  git(root, ['rm', '--quiet', '.env']);
  git(root, ['commit', '--quiet', '-m', 'remove fixture']);
  const result = check(root, ['--history']);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('private_data_in_history');
});
it.skipIf(process.platform === 'win32')(
  'does not print scanner findings to the terminal or CI log',
  () => {
    const root = repo();
    write(root, 'README.md', 'fixture');
    git(root, ['add', 'README.md']);
    const bin = join(root, 'test-tools');
    mkdirSync(bin);
    const value = ['scanner', 'private', 'fixture'].join('-');
    writeFileSync(
      join(bin, 'gitleaks'),
      `#!/bin/sh\nprintf '%s\\n' '${value}'\nprintf '%s\\n' '${value}' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    const result = check(root, ['--staged'], {
      ...process.env,
      PATH: bin + delimiter + (process.env.PATH || ''),
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('secret_scan_failed');
    expect(result.output).not.toContain(value);
  },
);
it.skipIf(process.platform === 'win32')(
  'rejects staged symlinks without following external data',
  () => {
    const root = repo();
    const target = join(tmpdir(), 'outside-login-fixture');
    symlinkSync(target, join(root, 'link'));
    git(root, ['add', 'link']);
    const result = check(root);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('unsupported_git_entry');
  },
);
