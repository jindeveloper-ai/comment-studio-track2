export interface YouTubeIdentity {
  loggedIn: boolean;
  channelId: string | null;
  channelName: string | null;
  channelHandle: string | null;
  needsChannel?: boolean;
}

// This function is serialized into a browser by Playwright. Keep it self-contained
// and free of nested named functions: tsx's keepNames adds Node-only __name helpers.
export async function readYouTubeIdentity(): Promise<YouTubeIdentity> {
  const w = window as unknown as { ytcfg?: { get: (key: string) => unknown } };
  if (typeof w.ytcfg?.get !== 'function' || w.ytcfg.get('LOGGED_IN') !== true)
    return {
      loggedIn: false,
      channelId: null,
      channelName: null,
      channelHandle: null,
    };
  let data: unknown = {};
  for (const menu of document.querySelectorAll(
    'ytd-multi-page-menu-renderer',
  )) {
    if (menu.getClientRects().length) {
      data = (menu as HTMLElement & { data?: unknown }).data || {};
      break;
    }
  }
  let header: Record<string, unknown> | undefined;
  const pending: unknown[] = [data];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    const o = value as Record<string, unknown>;
    const candidate = o.activeAccountHeaderRenderer || o.accountHeaderRenderer;
    if (candidate && typeof candidate === 'object') {
      header = candidate as Record<string, unknown>;
      break;
    }
    for (const child of Object.values(o).reverse()) pending.push(child);
  }
  let channelName: string | null = null;
  let channelHandle: string | null = null;
  if (header) {
    for (const key of ['accountName', 'channelHandle']) {
      const field = header[key] as
        | { simpleText?: unknown; runs?: { text?: unknown }[] }
        | undefined;
      let text = typeof field?.simpleText === 'string' ? field.simpleText : '';
      if (!text && Array.isArray(field?.runs))
        for (const run of field.runs)
          if (typeof run.text === 'string') text += run.text;
      if (key === 'accountName') channelName = text || null;
      else channelHandle = text || null;
    }
  }
  let channelId: string | null = null;
  let hasCreateChannel = false;
  const endpoints: { value: unknown; selected: boolean }[] = [
    { value: data, selected: false },
  ];
  // Prefer the selected account's own header over other menu sections.
  if (header) endpoints.push({ value: header, selected: true });
  const visited = new WeakSet<object>();
  while (endpoints.length && !channelId) {
    const entry = endpoints.pop();
    const value = entry?.value;
    if (!value || typeof value !== 'object') continue;
    if (visited.has(value)) continue;
    visited.add(value);
    const o = value as Record<string, unknown>;
    if ('channelCreationFormEndpoint' in o) hasCreateChannel = true;
    const endpoint = o.browseEndpoint as
      | { browseId?: unknown; canonicalBaseUrl?: unknown }
      | undefined;
    if (
      typeof endpoint?.browseId === 'string' &&
      /^UC[\w-]{22}$/.test(endpoint.browseId) &&
      (entry?.selected ||
        (channelHandle && endpoint.canonicalBaseUrl === `/${channelHandle}`))
    )
      channelId = endpoint.browseId;
    for (const child of Object.values(o).reverse())
      endpoints.push({ value: child, selected: !!entry?.selected });
  }
  return {
    loggedIn: true,
    channelId,
    channelName,
    channelHandle,
    needsChannel: !channelId && !channelHandle && hasCreateChannel,
  };
}

import type { Page } from 'playwright';

export async function getYouTubeIdentity(page: Page): Promise<YouTubeIdentity> {
  const loggedIn = await page.evaluate(() => {
    const w = window as unknown as {
      ytcfg?: { get?: (key: string) => unknown };
    };
    return (
      typeof w.ytcfg?.get === 'function' && w.ytcfg.get('LOGGED_IN') === true
    );
  });
  if (!loggedIn)
    return {
      loggedIn: false,
      channelId: null,
      channelName: null,
      channelHandle: null,
    };
  let opened = false;
  try {
    await page.locator('button#avatar-btn').first().click({ timeout: 8000 });
    opened = true;
    await page
      .locator(
        'ytd-multi-page-menu-renderer:visible ytd-active-account-header-renderer',
      )
      .first()
      .waitFor({ state: 'visible', timeout: 10000 });
    return await page.evaluate(readYouTubeIdentity);
  } finally {
    if (opened) await page.keyboard.press('Escape').catch(() => {});
  }
}
