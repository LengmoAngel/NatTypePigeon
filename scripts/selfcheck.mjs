import config from '../src/config.js';

const payload = {
  ok: true,
  note: 'RFC5780 probing requires TURN server with OTHER-ADDRESS support. This script validates configuration only.',
  stun_urls: config.stunUrls
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
