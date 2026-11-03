import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

const stores: Store[] = [];
function make() {
  const store = new Store(':memory:');
  stores.push(store);
  return createApp(store).app;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
describe('local API boundary', () => {
  it('requires explicit confirmation before any browser deletion', async () => {
    for (const body of [
      {},
      { confirmed: false },
      { confirmed: true, commentUrl: 'https://evil.test' },
    ]) {
      const r = await request(make())
        .post('/api/jobs/00000000-0000-4000-8000-000000000001/delete')
        .set('Host', '127.0.0.1')
        .set('X-Studio-Request', 'local')
        .send(body);
      expect(r.status).toBe(400);
    }
  });
  it('does not expose credential configuration or file contents', async () => {
    const r = await request(make()).get('/api/status').set('Host', '127.0.0.1');
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(
      /private_key|client_email|credentialPath|project_id|GOOGLE_APPLICATION/,
    );
  });
  it('rejects foreign origins, DNS rebinding and drive-by mutations', async () => {
    const app = make();
    expect(
      (await request(app).get('/api/status').set('Host', 'evil.test')).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/status')
          .set('Host', '127.0.0.1')
          .set('Origin', 'https://evil.test')
      ).status,
    ).toBe(403);
    expect(
      (await request(app).post('/api/posts').set('Host', '127.0.0.1').send({}))
        .status,
    ).toBe(403);
  });
  it('validates untrusted URLs before doing any network requests', async () => {
    const r = await request(make())
      .post('/api/videos/import')
      .set('Host', '127.0.0.1')
      .set('X-Studio-Request', 'local')
      .send({ url: 'https://127.0.0.1/private' });
    expect(r.status).toBe(400);
  });
  it('rejects bad inputs without echoing their values', async () => {
    const r = await request(make())
      .post('/api/posts')
      .set('Host', '127.0.0.1')
      .set('X-Studio-Request', 'local')
      .send({ draftId: 'untrusted-private-input' });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('untrusted-private-input');
  });
  it('validates recovery requests before opening a browser', async () => {
    const app = make();
    const r = await request(app)
      .post('/api/profiles/youtube1/open')
      .set('Host', '127.0.0.1')
      .set('X-Studio-Request', 'local')
      .send({ fresh: 'private-invalid-value' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
    expect(r.text).not.toContain('private-invalid-value');
  });
});
