import type { Locator, Page } from 'playwright';
import type { PostJob, Profile } from '../shared.js';
import { commentTarget } from './comment-target.js';
import { AppError } from './safety.js';

export async function deletionRow(
  page: Page,
  job: PostJob,
  profile: Profile,
): Promise<Locator | null> {
  const { commentId } = commentTarget(job);
  const rows = page.locator('ytd-comment-thread-renderer');
  const normalize = (s: string) =>
    s.normalize('NFC').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const href = await row
      .locator('a[href*="lc="]')
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (
      !href ||
      new URL(href, 'https://www.youtube.com').searchParams.get('lc') !==
        commentId
    )
      continue;
    const body = await row.locator('#content-text').first().innerText();
    const author = await row
      .locator('a#author-text')
      .first()
      .getAttribute('href');
    if (normalize(body) !== normalize(job.comment) || !author) continue;
    const path = new URL(author, 'https://www.youtube.com').pathname.replace(
      /\/$/,
      '',
    );
    if (
      path !== `/channel/${profile.channelId}` &&
      (!profile.channelHandle ||
        decodeURI(path) !== `/${profile.channelHandle}`)
    )
      continue;
    return row;
  }
  return null;
}

export async function deleteOwnedComment(
  page: Page,
  job: PostJob,
  profile: Profile,
  markSubmitted: () => void,
) {
  const row = await loadDeletionRow(page, job, profile);
  if (!row)
    throw new AppError(
      'DELETE_TARGET',
      '댓글 ID·작성 계정·본문이 모두 일치하는 댓글을 찾지 못해 삭제하지 않았습니다.',
      409,
    );
  await row.scrollIntoViewIfNeeded();
  await row.locator('#action-menu button').first().click({ timeout: 10000 });
  const menu = page.locator('ytd-menu-popup-renderer:visible');
  const remove = menu.getByText(/^(삭제|Delete)$/, { exact: true });
  await remove.waitFor({ state: 'visible', timeout: 8000 });
  const responseProof = page
    .waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes('/comment/perform_comment_action'),
      { timeout: 10000 },
    )
    .then(async (r) => {
      if (!r.ok()) return false;
      const data = await r.json();
      return (
        !data.error &&
        Array.isArray(data.actionResults) &&
        data.actionResults.some(
          (a: { status?: string }) => a.status === 'STATUS_SUCCEEDED',
        )
      );
    })
    .catch(() => false);
  markSubmitted();
  await remove.click({ timeout: 10000 });
  const dialog = page
    .locator(
      'yt-confirm-dialog-renderer:visible, ytd-confirm-dialog-renderer:visible, tp-yt-paper-dialog:visible',
    )
    .filter({ hasText: /댓글|comment/i });
  if (await dialog.count())
    await dialog
      .getByRole('button', { name: /^(삭제|Delete)$/ })
      .click({ timeout: 10000 });
  const toast = page.locator(
    'tp-yt-paper-toast:visible, ytd-toast:visible, yt-toast:visible, yt-notification-action-renderer:visible',
  );
  let confirmed = false;
  for (let i = 0; i < 10; i++) {
    const text = (await toast.allTextContents()).join(' ');
    if (
      /댓글(?:을|이)?\s*삭제(?:했|되었|됐)|댓글\s*삭제됨|comment (?:was )?deleted/i.test(
        text,
      )
    ) {
      confirmed = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  confirmed = confirmed || (await responseProof);
  if (!confirmed || (await deletionRow(page, job, profile)))
    throw new AppError(
      'DELETE_UNCERTAIN',
      '삭제를 요청했지만 YouTube의 삭제 완료 표시를 확인하지 못했습니다. 댓글 보기에서 직접 확인해 주세요. 자동 재삭제하지 않습니다.',
      409,
    );
}

export async function loadDeletionRow(
  page: Page,
  job: PostJob,
  profile: Profile,
) {
  let found = await deletionRow(page, job, profile);
  if (found) return found;
  const sort = page.locator('#comments yt-sort-filter-sub-menu-renderer');
  if (await sort.count()) {
    await sort.click({ timeout: 5000 });
    await page
      .locator('tp-yt-paper-item:visible')
      .filter({ hasText: /최신순|Newest first/ })
      .first()
      .click({ timeout: 5000 });
    await page.waitForTimeout(1000);
  }
  let previous = -1;
  for (let i = 0; i < 8; i++) {
    found = await deletionRow(page, job, profile);
    if (found) return found;
    const rows = page.locator('ytd-comment-thread-renderer');
    const size = await rows.count();
    if (size === 0 || size === previous) break;
    previous = size;
    await rows.last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(750);
  }
  return null;
}
