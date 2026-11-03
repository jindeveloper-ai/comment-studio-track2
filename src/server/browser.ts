import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';
import type { PostJob, Profile } from '../shared.js';
import { commentTarget } from './comment-target.js';
import { config } from './config.js';
import {
  type DefaultBrowser,
  type DetectedBrowser,
  defaultBrowser,
  openDefaultUrl,
  requireAutomation,
} from './default-browser.js';
import { deleteOwnedComment } from './delete-comment.js';
import { ManualLogin } from './manual-login.js';
import { AppError, safeError } from './safety.js';
import type { Store } from './store.js';
import { getYouTubeIdentity } from './youtube-identity.js';
import { ensureKoreanYouTube } from './youtube-language.js';

export class BrowserService {
  private contexts = new Map<string, BrowserContext>();
  private opening = new Set<string>();
  private connecting = new Set<string>();
  private busy = false;
  private refreshing = false;
  private manualLogin = new ManualLogin();
  constructor(
    private store: Store,
    private emit: () => void,
    private systemBrowser: DefaultBrowser = defaultBrowser,
  ) {}
  browserStatus() {
    return this.systemBrowser.status();
  }
  private browserKey(browser = this.systemBrowser.current): string {
    return createHash('sha256')
      .update(`${browser.id.toLowerCase()}|${browser.executable || ''}`)
      .digest('hex')
      .slice(0, 16);
  }
  private legacyChrome(browser: DetectedBrowser): boolean {
    return (
      browser.family === 'chrome' &&
      /^(?:com\.google\.chrome|chromehtml(?:\..+)?|google-chrome(?:-stable)?\.desktop)$/i.test(
        browser.id,
      )
    );
  }
  async refreshDefaultBrowser() {
    if (
      this.refreshing ||
      this.busy ||
      this.opening.size ||
      this.connecting.size ||
      this.store.activeJobs().length
    )
      throw new AppError(
        'BROWSER_BUSY',
        '진행 중인 작업이 끝난 뒤 기본 브라우저를 다시 감지해 주세요.',
        409,
      );
    this.refreshing = true;
    try {
      const previous = this.browserKey();
      const status = await this.systemBrowser.refresh();
      const current = this.browserKey();
      if (previous !== current) await this.close();
      for (const profile of this.store.profiles()) {
        const key = `profileBrowser.${profile.id}`;
        const saved = this.store.setting(key);
        // Preserve existing stable Chrome profiles when upgrading this app.
        if (!saved && this.legacyChrome(this.systemBrowser.current))
          this.store.setSetting(key, current);
        else if (saved !== current && profile.ready)
          this.store.setProfile(profile.id, false);
      }
      this.emit();
      return status;
    } finally {
      this.refreshing = false;
    }
  }
  assertPostingAvailable() {
    if (
      this.busy ||
      this.refreshing ||
      this.opening.size ||
      this.connecting.size
    )
      throw new AppError('BROWSER_BUSY', '기본 브라우저를 감지 중입니다.', 409);
    requireAutomation(this.systemBrowser.current);
  }
  private profile(id: string): Profile {
    const p = this.store.profiles().find((x) => x.id === id);
    if (!p) throw new AppError('PROFILE', '프로필을 찾을 수 없습니다.');
    return p;
  }
  private profileDirectory(
    id: string,
    browser = this.systemBrowser.current,
    newSession?: string,
  ): string {
    this.profile(id);
    const session =
      newSession ||
      this.store.setting(`profileSession.${this.browserKey(browser)}.${id}`);
    if (session) {
      if (
        !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(
          session,
        )
      )
        throw new AppError(
          'PROFILE_SESSION',
          '전용 로그인 세션 설정을 확인하지 못했습니다.',
        );
      return join(
        config.dataDir,
        'profiles',
        'sessions',
        this.browserKey(browser),
        id,
        session,
      );
    }
    return this.legacyChrome(browser)
      ? join(config.dataDir, 'profiles', id)
      : join(config.dataDir, 'profiles', this.browserKey(browser), id);
  }
  async openForLogin(id: string, fresh = false): Promise<void> {
    this.profile(id);
    if (
      this.refreshing ||
      this.busy ||
      this.store.activeJobs().length ||
      this.connecting.has(id) ||
      this.opening.has(id)
    )
      throw new AppError(
        'PROFILE_BUSY',
        '진행 중인 게시 또는 프로필 연결이 끝난 뒤 로그인 창을 열어 주세요.',
        409,
      );
    this.opening.add(id);
    try {
      const selected = await this.systemBrowser.resolve();
      if (selected.family === 'other' || !selected.executable) {
        if (fresh) requireAutomation(selected);
        await openDefaultUrl('https://www.youtube.com/?hl=ko');
        this.store.setProfile(id, false);
        this.emit();
        return;
      }
      const context = this.contexts.get(id);
      if (context) {
        await context.close();
        this.contexts.delete(id);
      }
      // A failed Google/YouTube session must not trap the user in the same cookies.
      // Keep the old directory intact and select a fresh directory only after launch succeeds.
      const session = fresh ? randomUUID() : undefined;
      const directory = this.profileDirectory(id, selected, session);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      await this.manualLogin.start(
        directory,
        directory,
        requireAutomation(selected),
      );
      if (session)
        this.store.setSetting(
          `profileSession.${this.browserKey(selected)}.${id}`,
          session,
        );
      this.store.setProfile(id, false);
      this.store.setSetting(`profileBrowser.${id}`, this.browserKey(selected));
      this.emit();
    } finally {
      this.opening.delete(id);
    }
  }
  async open(id: string, navigate = true): Promise<BrowserContext> {
    this.profile(id);
    if (this.refreshing)
      throw new AppError('BROWSER_BUSY', '기본 브라우저를 감지 중입니다.', 409);
    const selected = await this.systemBrowser.resolve();
    const executablePath = requireAutomation(selected);
    const old = this.contexts.get(id);
    if (old) return old;
    if (this.opening.has(id))
      throw new AppError(
        'PROFILE_BUSY',
        '프로필을 여는 중입니다. 잠시 기다려 주세요.',
        409,
      );
    this.opening.add(id);
    try {
      const dir = this.profileDirectory(id, selected);
      this.manualLogin.assertAvailable(dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const context = await chromium.launchPersistentContext(dir, {
        executablePath,
        headless: false,
        timeout: 25000,
        locale: 'ko-KR',
        viewport: null,
        // Match normal Chrome's OS credential store so manually saved login cookies
        // remain decryptable. Keep Playwright's automation and security flags intact.
        ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
        args: ['--lang=ko-KR', '--start-maximized'],
      });
      this.contexts.set(id, context);
      context.on('close', () => {
        if (this.contexts.get(id) === context) this.contexts.delete(id);
      });
      if (!navigate) return context;
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://www.youtube.com/?hl=ko', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.bringToFront();
      return context;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        'BROWSER_OPEN',
        '기본 브라우저의 전용 프로필을 열지 못했습니다. 같은 프로필을 사용하는 창을 닫은 뒤 다시 시도해 주세요.',
      );
    } finally {
      this.opening.delete(id);
    }
  }
  private async readIdentity(page: Page) {
    return getYouTubeIdentity(page);
  }
  async check(id: string): Promise<Profile> {
    this.profile(id);
    if (
      this.refreshing ||
      this.busy ||
      this.store.activeJobs().length ||
      this.opening.has(id) ||
      this.connecting.has(id)
    )
      throw new AppError(
        'PROFILE_BUSY',
        '게시가 끝난 뒤 프로필을 연결해 주세요.',
        409,
      );
    this.connecting.add(id);
    let step = 'session';
    try {
      const executable = requireAutomation(await this.systemBrowser.resolve());
      const directory = this.profileDirectory(id);
      if (!this.contexts.has(id))
        await this.manualLogin.finish(directory, directory, executable);
      step = 'browser';
      const context = await this.open(id, false);
      const page = context.pages()[0] || (await context.newPage());
      try {
        step = 'youtube';
        await page.goto('https://www.youtube.com/?hl=ko', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.locator('ytd-masthead').waitFor({ timeout: 12000 });
        step = 'channel';
        const identity = await this.readIdentity(page);
        if (identity.needsChannel) {
          this.store.setProfile(id, false);
          this.emit();
          throw new AppError(
            'YOUTUBE_CHANNEL_REQUIRED',
            'Google 로그인은 완료됐지만 현재 선택된 계정에 댓글을 작성할 YouTube 채널이 없습니다. 전용 창에서 기존 채널로 전환하거나 채널을 만든 뒤 다시 연결해 주세요.',
            409,
          );
        }
        if (!identity.loggedIn || !identity.channelId) {
          this.store.setProfile(id, false);
          this.emit();
          await context.close();
          throw new AppError(
            identity.loggedIn ? 'CHANNEL_UNVERIFIED' : 'LOGIN_REQUIRED',
            identity.loggedIn
              ? 'YouTube 로그인은 확인됐지만 채널 정보를 읽지 못했습니다. 채널 준비 여부를 확인해 주세요.'
              : '이 전용 프로필에 YouTube 로그인이 남아 있지 않습니다. 기본 브라우저로 로그인에서 직접 로그인한 뒤 로그인 완료 · 연결을 눌러 주세요.',
          );
        }
        await ensureKoreanYouTube(page);
        this.store.setProfile(
          id,
          true,
          identity.channelId,
          identity.channelName,
          identity.channelHandle,
        );
        this.store.setSetting(`profileBrowser.${id}`, this.browserKey());
        this.emit();
        return this.profile(id);
      } finally {
        await page.bringToFront().catch(() => {});
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'PROFILE_CHECK_FAILED',
        `${({ session: '전용 로그인 창 종료', browser: '게시용 브라우저 실행', youtube: 'YouTube 화면 로딩', channel: 'YouTube 채널 메뉴 확인' } as Record<string, string>)[step]} 단계에서 연결을 완료하지 못했습니다. 로그인 상태와 네트워크를 확인한 뒤 다시 연결해 주세요.`,
        502,
      );
    } finally {
      this.connecting.delete(id);
    }
  }
  private async authorMatches(page: Page, profile: Profile) {
    const identity = await this.readIdentity(page);
    return (
      identity.loggedIn &&
      !!profile.channelId &&
      identity.channelId === profile.channelId
    );
  }
  private async findOwnComment(
    page: Page,
    job: PostJob,
    profile: Profile,
  ): Promise<string | null> {
    const comments = page.locator('ytd-comment-thread-renderer');
    const count = await comments.count();
    const normalize = (s: string) =>
      s.normalize('NFC').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < count; i++) {
      const row = comments.nth(i);
      const body = await row
        .locator('#content-text')
        .first()
        .innerText()
        .catch(() => '');
      if (normalize(body) !== normalize(job.comment)) continue;
      const href = await row
        .locator('a#author-text')
        .first()
        .getAttribute('href');
      const mine =
        !!href &&
        (href.includes(profile.channelId || '\u0000') ||
          (!!profile.channelHandle &&
            decodeURI(href)
              .split('?')[0]
              .replace(/\/$/, '')
              .endsWith('/' + profile.channelHandle)));
      if (!mine) continue;
      await row.scrollIntoViewIfNeeded();
      const timeLink = await row
        .locator('a[href*="lc="]')
        .first()
        .getAttribute('href')
        .catch(() => null);
      return timeLink
        ? new URL(timeLink, 'https://www.youtube.com').href
        : `https://www.youtube.com/watch?v=${job.videoId}`;
    }
    return null;
  }
  async post(job: PostJob) {
    if (this.busy) {
      this.store.updateJob(job.id, {
        status: 'failed',
        message: '다른 브라우저 작업이 진행 중입니다.',
      });
      this.emit();
      return;
    }
    this.busy = true;
    let page: Page | undefined;
    const update = (patch: Partial<PostJob>) => {
      this.store.updateJob(job.id, patch);
      this.emit();
    };
    try {
      update({
        status: 'opening',
        message: '기본 브라우저에서 선택한 전용 프로필을 열고 있습니다.',
      });
      const profile = this.profile(job.profileId);
      const context = await this.open(profile.id);
      page = await context.newPage();
      await page.goto(`https://www.youtube.com/watch?v=${job.videoId}&hl=ko`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page.bringToFront();
      await ensureKoreanYouTube(page);
      await page
        .locator('#comments')
        .scrollIntoViewIfNeeded({ timeout: 15_000 });
      const placeholder = page
        .locator('ytd-comment-simplebox-renderer #placeholder-area')
        .first();
      await placeholder.waitFor({ timeout: 15000 });
      if (!(await this.authorMatches(page, profile)))
        throw new AppError(
          'ACCOUNT_MISMATCH',
          '댓글 작성 계정이 연결한 프로필과 일치하는지 확인하지 못했습니다. 프로필 연결을 다시 확인해 주세요.',
        );
      await placeholder.click();
      const editor = page
        .locator(
          'ytd-comment-simplebox-renderer #contenteditable-root[contenteditable="true"]',
        )
        .first();
      await editor.waitFor({ state: 'visible' });
      update({
        status: 'typing',
        message: '댓글을 한 글자씩 입력하고 있습니다.',
      });
      await editor.pressSequentially(job.comment, { delay: 70 });
      const entered = await editor.innerText();
      if (
        entered.normalize('NFC').trim() !== job.comment.normalize('NFC').trim()
      )
        throw new AppError(
          'INPUT_MISMATCH',
          '입력된 댓글이 초안과 일치하지 않아 게시를 멈췄습니다.',
        );
      const submit = page
        .locator('ytd-comment-simplebox-renderer #submit-button button')
        .first();
      if (!(await submit.isEnabled()))
        throw new AppError(
          'COMMENT_DISABLED',
          '댓글 게시 버튼을 사용할 수 없습니다.',
        );
      this.store.markSubmitting(job.id);
      this.emit();
      await submit.click({ timeout: 10000 });
      update({
        status: 'verifying',
        message: '게시한 계정과 댓글 내용을 확인하고 있습니다.',
      });
      let link: string | null = null;
      for (let i = 0; i < 8 && !link; i++) {
        await page.waitForTimeout(1000);
        link = await this.findOwnComment(page, job, profile);
      }
      if (!link)
        throw new AppError(
          'VERIFY_FAILED',
          '게시를 요청했지만 내 댓글을 확인하지 못했습니다. 재게시하지 말고 댓글 보기를 통해 확인해 주세요.',
        );
      update({
        status: 'success',
        message: '작성 계정과 댓글 본문을 확인했습니다.',
        commentUrl: link,
      });
    } catch (e) {
      const current = this.store.job(job.id);
      let screenshot: string | null = null;
      if (page) {
        const name = `${job.id}.png`;
        const dir = join(config.dataDir, 'screenshots');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (
          await page
            .screenshot({ path: join(dir, name), fullPage: false })
            .then(() => true)
            .catch(() => false)
        )
          screenshot = name;
      }
      update({
        status: current?.submittedAt ? 'uncertain' : 'failed',
        message: safeError(e),
        screenshot,
        commentUrl: `https://www.youtube.com/watch?v=${job.videoId}`,
      });
    } finally {
      this.busy = false;
    }
  }
  async verify(job: PostJob) {
    if (job.deletion)
      throw new AppError(
        'DELETE_STATE',
        '삭제 이력이 있는 댓글의 게시 상태는 변경하지 않습니다.',
        409,
      );
    if (!['uncertain', 'success'].includes(job.status))
      throw new AppError(
        'JOB_STATE',
        '게시 결과 확인이 필요한 작업만 다시 확인할 수 있습니다.',
      );
    const profile = this.profile(job.profileId);
    const context = await this.open(profile.id);
    const page = await context.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${job.videoId}&hl=ko`, {
      waitUntil: 'domcontentloaded',
    });
    await page.locator('#comments').scrollIntoViewIfNeeded({ timeout: 15000 });
    await page
      .locator('ytd-comment-thread-renderer')
      .first()
      .waitFor({ timeout: 15000 });
    const link = await this.findOwnComment(page, job, profile);
    if (!link)
      throw new AppError(
        'VERIFY_FAILED',
        '해당 계정의 댓글을 아직 확인하지 못했습니다. 재게시 없이 열린 화면에서 확인해 주세요.',
      );
    this.store.updateJob(job.id, {
      status: 'success',
      message: '재확인으로 내 댓글을 확인했습니다.',
      commentUrl: link,
    });
    this.emit();
  }
  async deleteComment(id: string) {
    this.assertPostingAvailable();
    const job = this.store.beginDeletion(id);
    this.busy = true;
    this.emit();
    let page: Page | undefined;
    try {
      const profile = this.profile(job.profileId);
      if (
        !profile.ready ||
        !profile.channelId ||
        (job.authorChannelId && job.authorChannelId !== profile.channelId)
      )
        throw new AppError(
          'ACCOUNT_MISMATCH',
          '게시 당시의 계정으로 전용 프로필을 다시 연결한 뒤 삭제해 주세요.',
          409,
        );
      const context = await this.open(job.profileId);
      page = await context.newPage();
      await page.goto(commentTarget(job).url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.bringToFront();
      await ensureKoreanYouTube(page);
      await page
        .locator('#comments')
        .scrollIntoViewIfNeeded({ timeout: 15000 });
      await page
        .locator('ytd-comment-thread-renderer')
        .first()
        .waitFor({ timeout: 15000 });
      if (!(await this.authorMatches(page, profile)))
        throw new AppError(
          'ACCOUNT_MISMATCH',
          '현재 YouTube 계정이 작성 계정과 달라 삭제하지 않았습니다.',
          409,
        );
      await deleteOwnedComment(page, job, profile, () => {
        this.store.markDeleting(id);
        this.emit();
      });
      this.store.updateDeletion(
        id,
        'deleted',
        'YouTube의 댓글 삭제 완료 응답 또는 표시와 대상 댓글이 사라진 것을 확인했습니다. 게시 이력과 제한은 보존됩니다.',
      );
    } catch (error) {
      const submitted = this.store.job(id)?.deletion?.submittedAt;
      if (page) {
        const dir = join(config.dataDir, 'screenshots');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const name = `${job.id}.png`;
        if (
          await page
            .screenshot({ path: join(dir, name) })
            .then(() => true)
            .catch(() => false)
        )
          this.store.updateJob(id, { screenshot: name });
      }
      this.store.updateDeletion(
        id,
        submitted ? 'uncertain' : 'failed',
        safeError(error),
      );
    } finally {
      this.busy = false;
      this.emit();
    }
    return this.store.job(id);
  }
  async close() {
    await Promise.allSettled([...this.contexts.values()].map((c) => c.close()));
  }
  async verifyDeletion(id: string) {
    this.assertPostingAvailable();
    if (this.store.activeJobs().length)
      throw new AppError(
        'BUSY',
        '진행 중인 작업이 끝난 뒤 확인해 주세요.',
        409,
      );
    const job = this.store.job(id);
    if (!job?.deletion || !['failed', 'uncertain'].includes(job.deletion.state))
      throw new AppError(
        'DELETE_STATE',
        '삭제 결과 확인이 필요한 댓글만 검사할 수 있습니다.',
        409,
      );
    this.busy = true;
    try {
      const profile = this.profile(job.profileId);
      if (
        !profile.ready ||
        !profile.channelId ||
        (job.authorChannelId && job.authorChannelId !== profile.channelId)
      )
        throw new AppError(
          'ACCOUNT_MISMATCH',
          '게시한 계정으로 프로필을 연결해 주세요.',
          409,
        );
      const context = await this.open(profile.id);
      const page = await context.newPage();
      await page.goto('https://www.youtube.com/?hl=ko', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      if (!(await this.authorMatches(page, profile)))
        throw new AppError(
          'ACCOUNT_MISMATCH',
          '작성 계정을 확인하지 못했습니다.',
          409,
        );
      await page.goto('https://www.youtube.com/feed/history/comment_history', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const empty = page
        .getByText(/활동 ?없음|아직 활동이 없습니다|No activity/i)
        .first();
      await empty.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      const url = new URL(page.url());
      if (
        url.hostname === 'myactivity.google.com' &&
        url.searchParams.get('page') === 'youtube_comments' &&
        (await empty.isVisible())
      ) {
        this.store.updateDeletion(
          id,
          'absent',
          '작성 프로필의 공식 YouTube 댓글 기록에 활동이 없음을 확인했습니다. 현재 댓글이 없으며, 삭제 완료 응답을 확인한 경우와 구분해 기록합니다. 게시 이력과 제한은 보존됩니다.',
        );
        const dir = join(config.dataDir, 'screenshots');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        await empty
          .screenshot({ path: join(dir, `${id}.png`) })
          .catch(() => {});
      } else
        throw new AppError(
          'DELETE_UNCERTAIN',
          '공식 댓글 기록에서 빈 기록을 확인하지 못했습니다. 열린 전용 창에서 해당 댓글을 직접 확인해 주세요. 다시 삭제하지 않았습니다.',
          409,
        );
    } finally {
      this.busy = false;
      this.emit();
    }
    return this.store.job(id);
  }
}
