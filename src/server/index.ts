import { createServer } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { config } from './config.js';
import { openDefaultUrl } from './default-browser.js';
import { closeCollector } from './youtube.js';

const { app, store, browser } = createApp();
await browser.refreshDefaultBrowser();
if (process.argv.includes('--production')) {
  app.use(express.static(resolve('dist')));
  app.use((_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}
const server = createServer(app);
let port = config.port;
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && port < config.port + 20) {
    port++;
    server.listen(port, '127.0.0.1');
  } else {
    console.error('로컬 서버를 시작하지 못했습니다.');
    process.exit(1);
  }
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Comment Studio: ${url}`);
  if (!process.argv.includes('--no-open'))
    void openDefaultUrl(url).catch(() =>
      console.error(
        '기본 브라우저를 열지 못했습니다. 로컬 주소로 접속해 주세요.',
      ),
    );
});
server.listen(port, '127.0.0.1');
const stop = async () => {
  await browser.close();
  await closeCollector();
  store.close();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});
