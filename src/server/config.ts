import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const daily = Number(process.env.DAILY_MAX_COMMENTS || 10);
if (!Number.isInteger(daily) || daily < 1 || daily > 100)
  throw new Error('하루 상한은 1~100 사이 정수여야 합니다.');
export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: resolve(process.env.DATA_DIR || '.local'),
  project: process.env.GOOGLE_CLOUD_PROJECT || '',
  location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
  model: process.env.VERTEX_MODEL || 'gemini-3.8-flash',
  credentialPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  dailyMax: daily,
};
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
export const credentialConfigured = () =>
  Boolean(
    config.project &&
      config.credentialPath &&
      existsSync(config.credentialPath),
  );
