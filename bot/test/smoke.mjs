// End-to-end smoke test for the bot, no WhatsApp or external APIs required.
// Spins up: a stub OpenWA API, a stub AniList, a stub nekostream, then the real
// bot (compiled dist/) and drives it with HMAC-signed webhook deliveries.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOT_ENTRY = path.join(TEST_DIR, '..', 'dist', 'index.js');

const SECRET = 'smoke-secret';
const BOT_PORT = 3301;
const OPENWA_PORT = 3390;
const ANILIST_PORT = 3391;
const NEKO_PORT = 3392;

const sent = [];
const webhookRegistrations = [];

function jsonServer(handler) {
  return http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    try {
      const result = await handler(req, JSON.parse(body || '{}'), req.url);
      res.writeHead(result.status ?? 200);
      res.end(JSON.stringify(result.body));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

async function startOpenwaStub() {
  let sessionId = '00000000-0000-0000-0000-000000000001';
  const server = jsonServer(async (req, parsed, url) => {
    if (req.method === 'GET' && url === '/api/sessions') {
      return { body: sessionId ? [{ id: sessionId, name: 'momo' }] : [] };
    }
    if (req.method === 'POST' && url.endsWith('/messages/send-text')) {
      sent.push(parsed);
      return { status: 201, body: { messageId: 'wa_msg_1', timestamp: 1719312000 } };
    }
    if (req.method === 'GET' && url.endsWith('/webhooks')) {
      return { body: [] };
    }
    if (req.method === 'POST' && url.endsWith('/webhooks')) {
      webhookRegistrations.push(parsed);
      return { status: 201, body: { id: 'wh_1', ...parsed } };
    }
    if (req.method === 'POST' && url === '/api/sessions') {
      return { status: 201, body: { id: sessionId, name: parsed.name, status: 'created' } };
    }
    return { status: 404, body: { error: 'not found', url } };
  });
  server.listen(OPENWA_PORT);
  await once(server, 'listening');
  return server;
}

function startAnilistStub() {
  const server = jsonServer(async (req) => {
    if (req.method === 'POST' && req.url === '/') {
      return {
        body: {
          data: {
            Page: {
              media: [
                { id: 1, idMal: 61316, title: { romaji: 'Re:Zero Season 4', english: 'Re:Zero' }, episodes: 12, format: 'TV' },
                { id: 2, idMal: 99999, title: { romaji: 'Re:Zero The Movie', english: null }, episodes: 1, format: 'MOVIE' },
              ],
            },
          },
        },
      };
    }
    return { status: 404, body: {} };
  });
  server.listen(ANILIST_PORT);
  return server;
}

function startNekoStub() {
  const server = jsonServer(async (req) => {
    if (req.method === 'GET' && req.url.startsWith('/61316/1/')) {
      return {
        body: {
          Kiwi: {
            sub: { download: { '360p': 'https://pahe.test/k1', '720p': 'https://pahe.test/k2', '1080p': 'https://pahe.test/k3' } },
            dub: { download: { '720p': 'https://pahe.test/kd' } },
          },
          gogoanime: { sub: { download: { '720p': 'https://gogo.test/g1' } } },
          status: { time: 1786627441, cache_expires_in: '1 hours', serves_from: 'cache' },
        },
      };
    }
    return { status: 404, body: {} };
  });
  server.listen(NEKO_PORT);
  return server;
}

function sign(body) {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

async function postWebhook(url, envelope) {
  const body = Buffer.from(JSON.stringify(envelope));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OpenWA-Signature': sign(body), 'X-OpenWA-Idempotency-Key': envelope.idempotencyKey },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `webhook rejected: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const openwa = await startOpenwaStub();
  const anilist = startAnilistStub();
  const neko = startNekoStub();
  await Promise.all([once(anilist, 'listening'), once(neko, 'listening')]);

  const bot = spawn('node', [BOT_ENTRY], {
    env: {
      ...process.env,
      BOT_PORT: String(BOT_PORT),
      OPENWA_URL: `http://127.0.0.1:${OPENWA_PORT}`,
      OPENWA_API_KEY: 'test-key',
      WEBHOOK_SECRET: SECRET,
      OPENWA_PUBLIC_URL: `http://127.0.0.1:${BOT_PORT}`,
      ANILIST_ENDPOINT: `http://127.0.0.1:${ANILIST_PORT}/`,
      NEKO_BASE_URL: `http://127.0.0.1:${NEKO_PORT}`,
      SEARCH_CACHE_TTL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bot.stdout.on('data', (d) => process.stdout.write(`[bot] ${d}`));
  bot.stderr.on('data', (d) => process.stderr.write(`[bot] ${d}`));

  try {
    const base = `http://127.0.0.1:${BOT_PORT}`;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);

    // Help command (with and without slash)
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_1',
      data: { id: 'wa_1', from: '1234@c.us', to: '9999@c.us', body: '/help', type: 'text', timestamp: 1, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Anime Download Bot'), true, 'help reply missing');
    assert.equal(sent.at(-1).quotedMessageId, 'wa_1', 'reply not quoted');

    // Multi-step: search -> pick -> episode -> quality
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2',
      data: { id: 'wa_2', from: '1234@c.us', to: '9999@c.us', body: 're zero', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    const list = sent.at(-1).text;
    assert.equal(list.includes('1. *Re:Zero Season 4'), true, 'search list missing match 1');
    assert.equal(list.includes('2. *Re:Zero The Movie*'), true, 'search list missing match 2');

    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_3',
      data: { id: 'wa_3', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 3, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('episode number'), true, 'episode prompt missing');

    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_4',
      data: { id: 'wa_4', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 4, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Choose *quality*'), true, 'quality prompt missing');

    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_5',
      data: { id: 'wa_5', from: '1234@c.us', to: '9999@c.us', body: '720p', type: 'text', timestamp: 5, isGroup: false, kind: 'individual', fromMe: false },
    });
    const card = sent.at(-1).text;
    assert.equal(card.includes('Episode 1 (720p)'), true, 'card header missing');
    assert.equal(card.includes('https://pahe.test/k2'), true, 'Kiwi sub 720p missing');
    assert.equal(card.includes('https://pahe.test/kd'), true, 'Kiwi dub 720p missing');
    assert.equal(card.includes('https://gogo.test/g1'), true, 'gogoanime 720p missing');
    assert.equal(card.includes('*Kiwi*'), true, 'server header missing');

    // Quick command
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6',
      data: { id: 'wa_6', from: '1234@c.us', to: '9999@c.us', body: 'd re zero 1', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    const quickReply = sent.at(-1).text;
    assert.equal(quickReply.includes('Matches for "re zero"'), true, 'quick command did not search');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6b',
      data: { id: 'wa_6b', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Choose *quality*'), true, 'quick command did not reach quality step');

    // Group flow: commands need a prefix, bare text ignored
    const before = sent.length;
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_7',
      data: { id: 'wa_7', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '1234@c.us', body: 'just chatting', type: 'text', timestamp: 7, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.length, before, 'bot replied to group chatter');

    // help without prefix in group: ignored
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_7b',
      data: { id: 'wa_7b', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '1234@c.us', body: 'help', type: 'text', timestamp: 7, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.length, before, 'bot replied to unprefixed help in group');

    // quick command without prefix in group: ignored
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_7c',
      data: { id: 'wa_7c', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '1234@c.us', body: 'd re zero 1', type: 'text', timestamp: 7, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.length, before, 'bot replied to unprefixed quick command in group');

    // prefixed commands in group work
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_7d',
      data: { id: 'wa_7d', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '1234@c.us', body: '/help', type: 'text', timestamp: 7, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Anime Download Bot'), true, 'prefixed /help in group did not reply');

    // ! prefix also works and starts a flow; bare numbers advance it
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_7e',
      data: { id: 'wa_7e', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '1234@c.us', body: '!d re zero 1', type: 'text', timestamp: 7, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Matches for "re zero"'), true, '!d quick command in group did not search');

    // Hijack attempt: another member replies "1" - must NOT advance A's flow
    const hijack = sent.length;
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_7h',
      data: { id: 'wa_7h', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '5555@c.us', body: '1', type: 'text', timestamp: 7, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.length, hijack, 'another member advanced the flow (hijack)');

    // The original author can still advance
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_7f',
      data: { id: 'wa_7f', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '1234@c.us', body: '1', type: 'text', timestamp: 7, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Choose *quality*'), true, 'bare number did not advance group flow');

    // Bad signature rejected
    const bad = Buffer.from(JSON.stringify({ event: 'message.received', data: { body: 'x' } }));
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenWA-Signature': 'sha256=deadbeef' },
      body: bad,
    });
    assert.equal(res.status, 401, 'bad signature accepted');

    // Webhook auto-registration happened
    assert.equal(webhookRegistrations.length >= 1, true, 'webhook auto-registration missing');
    assert.equal(webhookRegistrations.at(-1).url, `http://127.0.0.1:${BOT_PORT}/webhook`);

    console.log('\nSMOKE TEST PASSED: all assertions green');
    passed = true;
  } finally {
    bot.kill('SIGKILL');
    openwa.close();
    anilist.close();
    neko.close();
  }
}

let passed = false;
main()
  .then(() => process.exit(passed ? 0 : 1))
  .catch((err) => {
    console.error('SMOKE TEST FAILED:', err);
    process.exit(1);
  });