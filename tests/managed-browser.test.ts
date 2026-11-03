import { describe, expect, it } from 'vitest';
import { matchesManagedProfile } from '../src/server/managed-browser.js';

const executable =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const directory = resolve('work with spaces/.local/profiles/sessions/youtube1');
const uid = 501;
const identity = (profile: string) => ({
  uid,
  executable,
  command: `${executable} --user-data-dir=${profile} --lang=ko-KR --new-window https://www.youtube.com/?hl=ko`,
});

describe('managed browser identity boundary', () => {
  it('recognizes the exact application-owned profile with spaces', () => {
    expect(
      matchesManagedProfile(identity(directory), executable, directory, uid),
    ).toBe(true);
  });
  it('refuses the user personal Chrome profile', () => {
    expect(
      matchesManagedProfile(
        identity('/Users/reviewer/Library/Application Support/Google/Chrome'),
        executable,
        directory,
        uid,
      ),
    ).toBe(false);
  });
  it('refuses profile paths which only share a prefix', () => {
    for (const suffix of ['-other', '/other', ' backup'])
      expect(
        matchesManagedProfile(
          identity(directory + suffix),
          executable,
          directory,
          uid,
        ),
      ).toBe(false);
  });
  it('refuses another OS user or a different executable', () => {
    expect(
      matchesManagedProfile(
        { ...identity(directory), uid: 502 },
        executable,
        directory,
        uid,
      ),
    ).toBe(false);
    expect(
      matchesManagedProfile(
        { ...identity(directory), executable: '/unrelated/application' },
        executable,
        directory,
        uid,
      ),
    ).toBe(false);
  });
  it('refuses multiple profile arguments and shell wrappers', () => {
    expect(
      matchesManagedProfile(
        {
          ...identity(directory),
          command: identity(directory).command + ' --user-data-dir=/personal',
        },
        executable,
        directory,
        uid,
      ),
    ).toBe(false);
    expect(
      matchesManagedProfile(
        {
          ...identity(directory),
          command: 'wrapper ' + identity(directory).command,
        },
        executable,
        directory,
        uid,
      ),
    ).toBe(false);
  });
});

import { resolve } from 'node:path';
