import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { BrowserService } from './browser.js';
import { config } from './config.js';
import { openDefaultUrl } from './default-browser.js';
import {
  AppError,
  parseVideoId,
  safeError,
  validateComment,
} from './safety.js';
import { Store } from './store.js';
import { checkVertex, generateDraft, vertexStatus } from './vertex.js';
import { collectContext, searchVideos, videoDetails } from './youtube.js';

export function createApp(
  store = new Store(join(config.dataDir, 'studio.sqlite'), config.dailyMax),
) {
  const app = express();
  app.disable('x-powered-by');
  const events = new EventEmitter();
  const notify = () => events.emit('change');
  const browser = new BrowserService(store, notify);
  const draftLocks = new Set<string>();
  const status = () => ({
    browser: browser.browserStatus(),
    vertex: vertexStatus(),
    profiles: store.profiles(),
    quota: store.quota(),
    activeJobs: store.activeJobs(),
    reviewApproved: store.setting('reviewApproved') === 'true',
  });
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host))
      return res.status(403).json({ error: '로컬 접속만 허용됩니다.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`)
        return res
          .status(403)
          .json({ error: '다른 사이트에서의 접근은 허용되지 않습니다.' });
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        req.headers['x-studio-request'] !== 'local'
      )
        return res.status(403).json({ error: '대시보드에서 요청해 주세요.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/status', (_req, res) => res.json(status()));
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const send = () => res.write(`data: ${JSON.stringify(status())}\n\n`);
    send();
    events.on('change', send);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => {
      events.off('change', send);
      clearInterval(heartbeat);
    });
  });
  app.post('/api/vertex/check', async (_req, res) => {
    await checkVertex();
    notify();
    res.json(vertexStatus());
  });
  app.get('/api/videos', async (_req, res) => {
    const videos = await searchVideos();
    store.saveVideos(videos);
    res.json({
      videos,
      blockedIds: store.blockedVideos(),
      fetchedAt: new Date().toISOString(),
    });
  });
  app.post('/api/videos/import', async (req, res) => {
    const input = z.object({ url: z.string().max(2000) }).parse(req.body);
    const id = parseVideoId(input.url);
    const { video } = await videoDetails(id, 'direct');
    store.saveVideos([video]);
    res.json(video);
  });
  app.post('/api/drafts', async (req, res) => {
    const input = z
      .object({
        videoId: z.string().regex(/^[\w-]{11}$/),
        regenerate: z.boolean().default(false),
      })
      .parse(req.body);
    const video = store.video(input.videoId);
    if (!video) throw new AppError('VIDEO', '먼저 영상을 불러와 주세요.');
    const cached = store.latestDraft(video.id, video.source);
    if (cached && !input.regenerate)
      return res.json({ ...cached, cached: true });
    if (draftLocks.has(video.id))
      throw new AppError(
        'GENERATING',
        '이 영상의 초안을 생성하고 있습니다.',
        409,
      );
    draftLocks.add(video.id);
    try {
      store.claimDraftGeneration(video.id);
      const context = await collectContext(video);
      if (!context.topComments.length)
        throw new AppError(
          'COMMENTS_UNAVAILABLE',
          '인기 댓글을 읽지 못해 초안 생성을 멈췄습니다. 댓글이 공개된 영상으로 다시 시도해 주세요.',
          502,
        );
      const draft = await generateDraft(video, context, store.recentComments());
      store.saveDraft(draft);
      res.json(draft);
    } finally {
      draftLocks.delete(video.id);
      notify();
    }
  });
  app.post('/api/drafts/validate', (req, res) => {
    const input = z
      .object({ draftId: z.string().uuid(), comment: z.string().max(2000) })
      .parse(req.body);
    const draft = store.draft(input.draftId);
    if (!draft) throw new AppError('DRAFT', '초안을 찾을 수 없습니다.');
    res.json({
      errors: [
        ...validateComment(input.comment, draft.evidence, draft.context),
        ...(store.commentUsed(input.comment)
          ? ['다른 영상에 이미 사용한 댓글입니다. 새 초안을 준비해 주세요.']
          : []),
      ],
    });
  });
  app.post('/api/profiles/:id/open', async (req, res) => {
    const input = z
      .object({ fresh: z.boolean().default(false) })
      .parse(req.body || {});
    await browser.openForLogin(req.params.id, input.fresh);
    res.json({ ok: true, browser: browser.browserStatus() });
  });
  app.post('/api/profiles/:id/check', async (req, res) =>
    res.json(await browser.check(req.params.id)),
  );
  app.post('/api/browser/refresh', async (_req, res) =>
    res.json(await browser.refreshDefaultBrowser()),
  );
  app.post('/api/browser/open-review', async (req, res) => {
    const port = req.socket.localPort;
    await openDefaultUrl(`http://127.0.0.1:${port}/`);
    res.json({ ok: true });
  });
  app.post('/api/posts', (req, res) => {
    const input = z
      .object({
        draftId: z.string().uuid(),
        comment: z.string().max(2000),
        profileId: z.enum(['auto', 'youtube1', 'youtube2', 'youtube3']),
      })
      .parse(req.body);
    const draft = store.draft(input.draftId);
    const video = draft ? store.video(draft.videoId) : undefined;
    if (!draft || !video)
      throw new AppError('DRAFT', '먼저 영상 초안을 생성해 주세요.');
    const errors = validateComment(
      input.comment,
      draft.evidence,
      draft.context,
    );
    if (errors.length) throw new AppError('INVALID_COMMENT', errors.join(' '));
    browser.assertPostingAvailable();
    const job = store.reserve(video, draft, input.comment, input.profileId);
    notify();
    void browser.post(job).catch(() => {
      const current = store.job(job.id);
      if (current)
        store.updateJob(job.id, {
          status: current.submittedAt ? 'uncertain' : 'failed',
          message: '브라우저 작업이 중단되었습니다. 기록을 확인해 주세요.',
        });
      notify();
    });
    res.status(202).json(job);
  });
  app.get('/api/jobs', (_req, res) => res.json(store.jobs()));
  app.post('/api/jobs/:id/delete', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    res.json(await browser.deleteComment(id));
  });
  app.post('/api/jobs/:id/verify-deletion', async (req, res) =>
    res.json(
      await browser.verifyDeletion(z.string().uuid().parse(req.params.id)),
    ),
  );
  app.post('/api/jobs/:id/verify', async (req, res) => {
    const job = store.job(z.string().uuid().parse(req.params.id));
    if (!job) throw new AppError('JOB', '기록을 찾을 수 없습니다.', 404);
    await browser.verify(job);
    res.json(store.job(job.id));
  });
  app.get('/api/screenshots/:id', (req, res) => {
    if (!/^[\da-f-]{36}\.png$/.test(req.params.id))
      throw new AppError('SCREENSHOT', '화면 캡처를 찾을 수 없습니다.', 404);
    const job = store.job(req.params.id.slice(0, -4));
    if (!job?.screenshot)
      throw new AppError('SCREENSHOT', '화면 캡처를 찾을 수 없습니다.', 404);
    res.sendFile(job.screenshot, {
      root: join(config.dataDir, 'screenshots'),
      dotfiles: 'deny',
    });
  });
  let discoverBusy = false;
  app.post('/api/discovery', async (_req, res) => {
    if (discoverBusy)
      throw new AppError(
        'DISCOVERY_BUSY',
        '조회수 관측 중입니다. 잠시 기다려 주세요.',
        409,
      );
    discoverBusy = true;
    try {
      const found = await searchVideos('discovery', 20);
      const measured = [];
      // Exact watch-page counts, never rounded search counts, are used for growth.
      for (let i = 0; i < found.length; i += 4) {
        const batch = await Promise.allSettled(
          found.slice(i, i + 4).map((v) => videoDetails(v.id, 'discovery')),
        );
        for (const r of batch)
          if (r.status === 'fulfilled') {
            const v = r.value.video;
            if (v.viewCount !== null) {
              store.observe(v.id, v.viewCount);
              measured.push(store.discovery(v));
            }
          }
      }
      if (!measured.length)
        throw new AppError(
          'DISCOVERY_EMPTY',
          '정확한 조회수를 수집하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
          502,
        );
      store.saveVideos(measured);
      res.json({
        videos: measured.sort(
          (a, b) => Number(b.eligible) - Number(a.eligible),
        ),
        message:
          '처음 관측한 영상은 측정 중입니다. 1시간 후 다시 관측하면 시간당 증가량을 계산합니다.',
      });
    } finally {
      discoverBusy = false;
    }
  });
  app.get('/api/review', (_req, res) =>
    res.json({
      approved: store.setting('reviewApproved') === 'true',
      videoProductionStarted: false,
    }),
  );
  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _req,
    res,
    _next,
  ) => {
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: '입력 형식이 올바르지 않습니다.', code: 'VALIDATION' });
      return;
    }
    res.status(error instanceof AppError ? error.status : 500).json({
      error: safeError(error),
      code: error instanceof AppError ? error.code : 'INTERNAL',
    });
  };
  app.use('/api', errorHandler);
  return { app, store, browser, notify };
}
