import { execFile } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export function profileLockPid(directory: string): number | null {
  try {
    const pid = Number(
      /-(\d+)$/.exec(readlinkSync(join(directory, 'SingletonLock')))?.[1],
    );
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}
export interface ProcessIdentity {
  uid: number;
  executable: string;
  command: string;
}
export function matchesManagedProfile(
  info: ProcessIdentity,
  executable: string,
  directory: string,
  uid: number,
): boolean {
  if (
    info.uid !== uid ||
    info.executable !== executable ||
    !info.command.startsWith(`${executable} `)
  )
    return false;
  const parts = info.command.split(' --user-data-dir=');
  if (parts.length !== 2) return false;
  const expected = resolve(directory);
  if (!parts[1].startsWith(expected)) return false;
  const rest = parts[1].slice(expected.length);
  return (
    !rest ||
    rest.startsWith(' --') ||
    rest.startsWith(' https://www.youtube.com/')
  );
}
export async function inspectManagedProfile(
  executable: string,
  directory: string,
): Promise<{ pid: number; automated: boolean } | null> {
  const pid = profileLockPid(directory);
  if (!pid) return null;
  try {
    const fields = await Promise.all(
      ['uid', 'comm', 'command'].map(async (field) =>
        (
          await execute(
            '/bin/ps',
            ['-ww', '-p', String(pid), '-o', `${field}=`],
            { timeout: 2000, maxBuffer: 128 * 1024 },
          )
        ).stdout.trim(),
      ),
    );
    const info = {
      uid: Number(fields[0]),
      executable: fields[1],
      command: fields[2],
    };
    if (
      !matchesManagedProfile(
        info,
        executable,
        directory,
        process.getuid?.() ?? -1,
      )
    )
      return null;
    return {
      pid,
      automated:
        /(?:^|\s)--(?:enable-automation|remote-debugging[^=\s]*)\b/.test(
          info.command,
        ),
    };
  } catch {
    return null;
  }
}
// Only the browser holding this application's exact profile may be asked to exit.
// Never signal the OS launcher, a personal profile, another user, or a reused PID.
export async function closeManagedProfile(
  executable: string,
  directory: string,
): Promise<boolean> {
  const browser = await inspectManagedProfile(executable, directory);
  if (!browser || profileLockPid(directory) !== browser.pid) return false;
  try {
    process.kill(browser.pid, 'SIGTERM');
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
