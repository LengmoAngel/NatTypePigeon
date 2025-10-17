import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:global.stun.twilio.com:3478'
];

function parseStunUrls(raw) {
  if (!raw) {
    return DEFAULT_STUN;
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const stunUrls = parseStunUrls(process.env.STUN_URLS);

function parseCorsOrigins(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  wsPath: process.env.WS_PATH ?? '/ws',
  stunUrls,
  iceServers: stunUrls.length ? [{ urls: stunUrls }] : [],
  disableLimit: (process.env.DISABLE_LIMIT ?? 'true').toLowerCase() !== 'false',
  resultPersist: (process.env.RESULT_PERSIST ?? 'false').toLowerCase() === 'true',
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS ?? ''),
  logLevel: process.env.LOG_LEVEL ?? 'info'
};

export default config;
