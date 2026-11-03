import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPublicFile,
  isPrivatePublicPath,
  PublicSafetyError,
} from './public-safety.ts';

function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new PublicSafetyError('git_unavailable');
  return result.stdout;
}
function entries(bytes) {
  return bytes
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d{6}) (\w+) ([0-3])\t([\s\S]+)$/.exec(line);
      if (!match || match[3] !== '0')
        throw new PublicSafetyError('unresolved_index');
      return { mode: match[1], hash: match[2], file: match[4] };
    });
}
function scan(args, root) {
  // Capture both streams. Never echo a scanner match, request, cookie, or key.
  const result = spawnSync(
    'gitleaks',
    [
      ...args,
      '--config',
      fileURLToPath(new URL('../.gitleaks.toml', import.meta.url)),
      '--gitleaks-ignore-path',
      devNull,
      '--ignore-gitleaks-allow',
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--log-level',
      'error',
      '--timeout',
      '120',
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 125000 },
  );
  if (result.error) throw new PublicSafetyError('scanner_unavailable');
  if (result.status !== 0) throw new PublicSafetyError('secret_scan_failed');
}
let directory;
try {
  const root = realpathSync(
    git(['rev-parse', '--show-toplevel']).toString('utf8').trim(),
  );
  const stagedOnly = process.argv.includes('--staged');
  const history = process.argv.includes('--history');
  const indexed = entries(git(['ls-files', '--stage', '-z'], root));
  directory = mkdtempSync(join(tmpdir(), 'comment-studio-public-'));
  let count = 0;
  for (const item of indexed) {
    if (!['100644', '100755'].includes(item.mode))
      throw new PublicSafetyError('unsupported_git_entry');
    const bytes = git(['cat-file', 'blob', item.hash], root);
    assertPublicFile(item.file, bytes);
    const target = join(directory, 'index', item.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    count++;
  }
  if (!stagedOnly) {
    const files = git(
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      root,
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    for (const file of files) {
      if (isPrivatePublicPath(file))
        throw new PublicSafetyError('protected_path');
      const source = join(root, file);
      if (!existsSync(source)) continue;
      const actual = realpathSync(source);
      const inside = relative(root, actual);
      if (
        inside === '..' ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside) ||
        isPrivatePublicPath(inside.split(sep).join('/')) ||
        lstatSync(source).isSymbolicLink()
      )
        throw new PublicSafetyError('symlink_or_external_file');
      if (!lstatSync(source).isFile())
        throw new PublicSafetyError('unsupported_file');
      const bytes = readFileSync(source);
      assertPublicFile(file, bytes);
      const target = join(directory, 'working', file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { mode: 0o600 });
      count++;
    }
  }
  if (count) scan(['dir', directory], root);
  if (history) {
    const commits = git(['rev-list', '--all'], root)
      .toString('utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const commit of commits) {
      const files = git(['ls-tree', '-r', '-z', commit], root)
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      for (const entry of files) {
        const match = /^(\d{6}) blob ([a-f\d]+)\t([\s\S]+)$/.exec(entry);
        if (!match || !['100644', '100755'].includes(match[1]))
          throw new PublicSafetyError('unsupported_history_entry');
        if (isPrivatePublicPath(match[3]))
          throw new PublicSafetyError('private_data_in_history');
        assertPublicFile(match[3], git(['cat-file', 'blob', match[2]], root));
      }
    }
    if (commits.length) scan(['git', root, '--log-opts=--all'], root);
  }
  console.log(
    count
      ? `Public safety passed: ${count} snapshots; exact Git index checked; Gitleaks output suppressed.`
      : 'Public safety: no indexed files to scan.',
  );
} catch (error) {
  const category =
    error instanceof PublicSafetyError ? error.category : 'inspection_failed';
  console.error(
    `Public safety blocked (${category}). Sensitive contents and scanner output suppressed.`,
  );
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
