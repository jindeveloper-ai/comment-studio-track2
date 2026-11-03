import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('runs tsx-compiled account code in an isolated browser context without Node transform helpers', () => {
  const url = new URL('../src/server/youtube-identity.ts', import.meta.url)
    .href;
  const script = `
    import { runInNewContext } from 'node:vm';
    import { readYouTubeIdentity } from ${JSON.stringify(url)};
    const mine = 'UC' + 'a'.repeat(22);
    const other = 'UC' + 'b'.repeat(22);
    const fixtures = [
      { signedIn: false },
      { signedIn: true, data: {
        header: { activeAccountHeaderRenderer: { accountName: { simpleText: 'Google account' } } },
        unrelated: { browseEndpoint: { browseId: other } },
        sections: [{ channelCreationFormEndpoint: {} }]
      } },
      { signedIn: true, data: {
        unrelated: { browseEndpoint: { browseId: other } },
        header: { activeAccountHeaderRenderer: {
          accountName: { runs: [{ text: 'Test channel' }] },
          channelHandle: { simpleText: '@test-channel' },
          channelHandleNavigationEndpoint: { browseEndpoint: { browseId: mine } }
        } }
      } }
    ];
    const results = [];
    for (const fixture of fixtures) {
      let fetched = false;
      const browser = {
        window: { ytcfg: { get: key => key === 'LOGGED_IN' ? fixture.signedIn : {} } },
        document: { querySelectorAll: () => [{ data: fixture.data, getClientRects: () => [1] }] },
        AbortSignal,
        fetch: async () => { fetched = true; throw new Error('Unexpected authenticated API request'); }
      };
      const result = await runInNewContext('(' + readYouTubeIdentity.toString() + ')()', browser);
      results.push({ ...result, fetched });
    }
    console.log(JSON.stringify(results));
  `;
  const results = JSON.parse(
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10000 },
    ),
  );
  expect(results[0]).toMatchObject({ loggedIn: false, fetched: false });
  expect(results[1]).toMatchObject({
    loggedIn: true,
    channelId: null,
    needsChannel: true,
    fetched: false,
  });
  expect(results[2]).toMatchObject({
    loggedIn: true,
    channelId: 'UC' + 'a'.repeat(22),
    channelName: 'Test channel',
    channelHandle: '@test-channel',
    fetched: false,
  });
});
