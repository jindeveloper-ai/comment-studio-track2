import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { getYouTubeIdentity } from '../src/server/youtube-identity.js';

function fixture() {
  const click = vi.fn().mockResolvedValue(undefined);
  const waitFor = vi.fn().mockResolvedValue(undefined);
  const press = vi.fn().mockResolvedValue(undefined);
  const evaluate = vi.fn();
  const page = {
    evaluate,
    locator: vi.fn(() => ({ first: () => ({ click, waitFor }) })),
    keyboard: { press },
  } as unknown as Page;
  return { page, evaluate, click, waitFor, press };
}
it('does not open account menus or start sign-in when the page is signed out', async () => {
  const f = fixture();
  f.evaluate.mockResolvedValue(false);
  expect(await getYouTubeIdentity(f.page)).toMatchObject({
    loggedIn: false,
    channelId: null,
  });
  expect(f.click).not.toHaveBeenCalled();
  expect(f.press).not.toHaveBeenCalled();
});
it('uses the native authenticated account menu and closes it before returning', async () => {
  const f = fixture();
  f.evaluate.mockResolvedValueOnce(true).mockResolvedValueOnce({
    loggedIn: true,
    channelId: 'UC' + 'a'.repeat(22),
    channelName: 'test',
  });
  expect(await getYouTubeIdentity(f.page)).toMatchObject({
    loggedIn: true,
    channelName: 'test',
  });
  expect(f.click).toHaveBeenCalledOnce();
  expect(f.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 10000 });
  expect(f.press).toHaveBeenCalledWith('Escape');
});
it('still closes the menu if account extraction fails', async () => {
  const f = fixture();
  f.evaluate
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error('fixture failure'));
  await expect(getYouTubeIdentity(f.page)).rejects.toThrow('fixture failure');
  expect(f.press).toHaveBeenCalledWith('Escape');
});
