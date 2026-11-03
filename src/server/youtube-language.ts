import type { Page } from 'playwright';
import { AppError } from './safety.js';

export async function ensureKoreanYouTube(page: Page) {
  await page.locator('ytd-masthead').waitFor({ timeout: 15000 });
  if ((await page.locator('html').getAttribute('lang'))?.startsWith('ko'))
    return;
  try {
    await page.locator('button#avatar-btn').click({ timeout: 8000 });
    const language = page
      .locator('ytd-multi-page-menu-renderer:visible')
      .getByText(/(?:Display language|Language|표시 언어|언어)\s*:/i)
      .last();
    await language.waitFor({ state: 'visible', timeout: 10000 });
    await language.click();
    await page.getByText('한국어', { exact: true }).click({ timeout: 10000 });
    await page.waitForFunction(
      () => document.documentElement.lang.startsWith('ko'),
      {},
      { timeout: 15000 },
    );
  } catch {
    throw new AppError(
      'YOUTUBE_LANGUAGE',
      '한국어 표시 언어를 확인하지 못해 작업을 멈췄습니다. 전용 YouTube 창의 프로필 메뉴에서 표시 언어를 한국어로 바꾼 뒤 다시 시도해 주세요.',
      409,
    );
  }
}
