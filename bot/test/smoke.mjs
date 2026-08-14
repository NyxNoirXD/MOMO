// End-to-end smoke test for the bot, no WhatsApp or external APIs required.
// Spins up: a stub OpenWA API, a stub AniList, a stub nekostream, then the real
// bot (compiled dist/) and drives it with HMAC-signed webhook deliveries.
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
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
const ADMIN_JID = '62811112222@c.us';
const ADMIN_DATA_FILE = path.join(os.tmpdir(), 'momo-smoke-admin.json');

const sent = [];
const sentImages = [];
const webhookRegistrations = [];
let failImages = false;

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
      return {
        body: sessionId
          ? [{ id: sessionId, name: 'momo', status: 'ready', phone: '62811112222', pushName: 'MomoBot', connectedAt: '2026-08-14T00:00:00Z' }]
          : [],
      };
    }
    if (req.method === 'GET' && /\/api\/sessions\/[^/]+\/qr$/.test(url)) {
      return { body: { qrCode: 'data:image/png;base64,QUJD', status: 'qr_ready' } };
    }
    if (req.method === 'POST' && url.endsWith('/messages/send-text')) {
      sent.push(parsed);
      return { status: 201, body: { messageId: 'wa_msg_1', timestamp: 1719312000 } };
    }
    if (req.method === 'POST' && url.endsWith('/messages/send-image')) {
      sentImages.push(parsed);
      if (failImages) {
        return { status: 500, body: { error: 'image upload failed' } };
      }
      return { status: 201, body: { messageId: 'wa_img_1', timestamp: 1719312000 } };
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
  const server = jsonServer(async (req, parsed) => {
    if (req.method === 'POST' && req.url === '/') {
      if (parsed.query?.includes('Media(idMal')) {
        return {
          body: {
            data: {
              Media: { episodes: 12, nextAiringEpisode: { episode: 9 } },
            },
          },
        };
      }
      return {
        body: {
          data: {
            Page: {
              media: [
                { id: 1, idMal: 61316, title: { romaji: 'Re:Zero Season 4', english: 'Re:Zero' }, episodes: 12, format: 'TV', status: 'RELEASING', startDate: { year: 2016 }, nextAiringEpisode: { episode: 8 }, coverImage: { large: 'https://img.test/cover-rezero.jpg' }, description: 'A boy gets reincarnated into a fantasy world.', meanScore: 90, duration: 25, genres: ['Drama', 'Fantasy'], studios: { nodes: [{ name: 'White Fox' }] } },
                { id: 2, idMal: 99999, title: { romaji: 'Re:Zero The Movie', english: null }, episodes: 1, format: 'MOVIE', status: 'FINISHED', startDate: { year: 2019 }, coverImage: { large: 'https://img.test/cover-movie.jpg' } },
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
    if (req.method === 'GET' && /^\/61316\/\d+\//.test(req.url)) {
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
  for (const f of [ADMIN_DATA_FILE, path.join(os.tmpdir(), 'momo-smoke-prefs.json'), path.join(os.tmpdir(), 'momo-smoke-subs.json'), path.join(os.tmpdir(), 'momo-smoke-admin2.json')]) {
    fs.rmSync(f, { force: true });
  }
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
      ADMIN_JIDS: '62811112222',
      ADMIN_DATA_FILE,
      PREF_DATA_FILE: path.join(os.tmpdir(), 'momo-smoke-prefs.json'),
      SUBS_DATA_FILE: path.join(os.tmpdir(), 'momo-smoke-subs.json'),
      RATE_LIMIT_MS: '0',
      SUB_POLL_MS: '1000',
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

    // Multi-step: search -> pick -> episode -> sub/dub -> quality
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2',
      data: { id: 'wa_2', from: '1234@c.us', to: '9999@c.us', body: 're zero', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    const list = sent.at(-1).text;
    assert.equal(list.includes('1. *Re:Zero Season 4'), true, 'search list missing match 1');
    assert.equal(list.includes('2. *Re:Zero The Movie*'), true, 'search list missing match 2');
    assert.equal(list.includes('2016'), true, 'search list missing release year');
    assert.equal(list.includes('12 eps'), true, 'search list missing episode count');

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
    assert.equal(sent.at(-1).text.includes('Choose *language*'), true, 'language prompt missing after episode');

    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_4b',
      data: { id: 'wa_4b', from: '1234@c.us', to: '9999@c.us', body: 'sub', type: 'text', timestamp: 4, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Choose *quality*'), true, 'quality prompt missing after language');

    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_5',
      data: { id: 'wa_5', from: '1234@c.us', to: '9999@c.us', body: '720p', type: 'text', timestamp: 5, isGroup: false, kind: 'individual', fromMe: false },
    });
    const card = sentImages.at(-1).caption;
    assert.equal(card.includes('Episode 1 (sub, 720p)'), true, 'card header missing');
    assert.equal(card.includes('https://pahe.test/k2'), true, 'Kiwi sub 720p missing');
    assert.equal(card.includes('https://pahe.test/kd'), false, 'dub link leaked into sub-only card');
    assert.equal(card.includes('https://gogo.test/g1'), true, 'gogoanime 720p missing');
    assert.equal(card.includes('*Kiwi*'), true, 'server header missing');

    // Cover image attached to the final card as caption, quoted reply
    const img = sentImages.at(-1);
    assert.equal(img.media.url, 'https://img.test/cover-rezero.jpg', 'cover image url wrong');
    assert.equal(img.caption.includes('Episode 1 (sub, 720p)'), true, 'cover caption missing card text');
    assert.equal(img.chatId, '1234@c.us', 'image sent to wrong chat');
    assert.equal(img.quotedMessageId, 'wa_5', 'image reply not quoted');

    // Range in the flow: 5-8 -> sub -> 720p -> one combined card
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2b',
      data: { id: 'wa_2b', from: '1234@c.us', to: '9999@c.us', body: 're zero', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_3b',
      data: { id: 'wa_3b', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 3, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_4b2',
      data: { id: 'wa_4b2', from: '1234@c.us', to: '9999@c.us', body: '5-8', type: 'text', timestamp: 4, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Episodes 5-8'), true, 'range did not reach language prompt');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_4b3',
      data: { id: 'wa_4b3', from: '1234@c.us', to: '9999@c.us', body: 'sub', type: 'text', timestamp: 4, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_5b',
      data: { id: 'wa_5b', from: '1234@c.us', to: '9999@c.us', body: '720p', type: 'text', timestamp: 5, isGroup: false, kind: 'individual', fromMe: false },
    });
    const rangeCard = sentImages.at(-1).caption;
    assert.equal(rangeCard.includes('Episodes 5-8 (sub, 720p)'), true, 'range card header missing');
    assert.equal(rangeCard.includes('Ep 5: https://pahe.test/k2'), true, 'range card missing ep 5');
    assert.equal(rangeCard.includes('Ep 8: https://pahe.test/k2'), true, 'range card missing ep 8');

    // 'latest' keyword at the episode step resolves via nextAiringEpisode (ep 8 -> 7)
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_3c',
      data: { id: 'wa_3c', from: '1234@c.us', to: '9999@c.us', body: 're zero', type: 'text', timestamp: 3, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_3d',
      data: { id: 'wa_3d', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 3, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_3e',
      data: { id: 'wa_3e', from: '1234@c.us', to: '9999@c.us', body: 'latest', type: 'text', timestamp: 3, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Episode 7'), true, 'latest keyword at episode step did not resolve');

    // Mid-flow, a new anime name restarts the search instead of being nudged
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_3f',
      data: { id: 'wa_3f', from: '1234@c.us', to: '9999@c.us', body: 're zero', type: 'text', timestamp: 3, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Matches for "re zero"'), true, 'new search mid-flow did not restart');

    // Oversized range rejected
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2c',
      data: { id: 'wa_2c', from: '1234@c.us', to: '9999@c.us', body: 'd re zero 1-30', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Max *24* episodes per request'), true, 'oversized range not rejected');

    // Multi-episode lists: 1,3,5 and mixed 1-2,4
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_1',
      data: { id: 'wa_list_1', from: '1234@c.us', to: '9999@c.us', body: 'd re zero 1,3,5', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Matches for "re zero"'), true, 'list quick command did not search');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_2',
      data: { id: 'wa_list_2', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Episodes 1-5 (3)'), true, 'list did not reach language prompt with label');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_3',
      data: { id: 'wa_list_3', from: '1234@c.us', to: '9999@c.us', body: 'sub', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_4',
      data: { id: 'wa_list_4', from: '1234@c.us', to: '9999@c.us', body: '720p', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    const listCard = sentImages.at(-1).caption;
    assert.equal(listCard.includes('Episodes 1-5 (sub, 720p)'), true, 'list card header missing');
    assert.equal(listCard.includes('Ep 1: https://pahe.test/k2'), true, 'list card missing ep 1');
    assert.equal(listCard.includes('Ep 3: https://pahe.test/k2'), true, 'list card missing ep 3');
    assert.equal(listCard.includes('Ep 5: https://pahe.test/k2'), true, 'list card missing ep 5');
    assert.equal(listCard.includes('Ep 2: https://pahe.test/k2'), false, 'list card leaked unselected ep 2');

    // Mixed list in the flow: 1-2,4
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_5',
      data: { id: 'wa_list_5', from: '1234@c.us', to: '9999@c.us', body: 're zero', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_6',
      data: { id: 'wa_list_6', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_7',
      data: { id: 'wa_list_7', from: '1234@c.us', to: '9999@c.us', body: '1-2,4', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Episodes 1-4 (3)'), true, 'mixed list did not reach language prompt');

    // Oversized list rejected (even after dedupe)
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_list_8',
      data: { id: 'wa_list_8', from: '1234@c.us', to: '9999@c.us', body: 'd re zero 1-25,1-5', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Max *24* episodes per request'), true, 'oversized list not rejected');

    // 'latest' in the quick command resolves via nextAiringEpisode (ep 8 -> latest 7)
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2d',
      data: { id: 'wa_2d', from: '1234@c.us', to: '9999@c.us', body: 'd re zero latest', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Matches for "re zero"'), true, 'latest quick command did not search');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2e',
      data: { id: 'wa_2e', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Episode 7'), true, 'latest did not resolve to nextAiringEpisode - 1');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2f',
      data: { id: 'wa_2f', from: '1234@c.us', to: '9999@c.us', body: 'sub', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_2g',
      data: { id: 'wa_2g', from: '1234@c.us', to: '9999@c.us', body: '720p', type: 'text', timestamp: 2, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sentImages.at(-1).caption.includes('Episode 7 (sub, 720p)'), true, 'latest quick command card wrong');

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
    assert.equal(sent.at(-1).text.includes('Choose *language*'), true, 'quick command did not reach language step');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6c',
      data: { id: 'wa_6c', from: '1234@c.us', to: '9999@c.us', body: 'dub', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6d',
      data: { id: 'wa_6d', from: '1234@c.us', to: '9999@c.us', body: '720p', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    const dubCard = sentImages.at(-1).caption;
    assert.equal(dubCard.includes('Episode 1 (dub, 720p)'), true, 'dub card header missing');
    assert.equal(dubCard.includes('https://pahe.test/kd'), true, 'Kiwi dub 720p missing');
    assert.equal(dubCard.includes('https://pahe.test/k2'), false, 'sub link leaked into dub-only card');

    // Image upload failure falls back to a plain text card
    failImages = true;
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6e',
      data: { id: 'wa_6e', from: '1234@c.us', to: '9999@c.us', body: 'd re zero 2', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6f',
      data: { id: 'wa_6f', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6g',
      data: { id: 'wa_6g', from: '1234@c.us', to: '9999@c.us', body: 'sub', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_6h',
      data: { id: 'wa_6h', from: '1234@c.us', to: '9999@c.us', body: '720p', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Episode 2 (sub, 720p)'), true, 'fallback card missing');
    failImages = false;

    // Quality fallback: Kiwi has 1080p, gogoanime only 720p -> annotated fallback
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_fb_1',
      data: { id: 'wa_fb_1', from: '1234@c.us', to: '9999@c.us', body: 'd re zero 1', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_fb_2',
      data: { id: 'wa_fb_2', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_fb_3',
      data: { id: 'wa_fb_3', from: '1234@c.us', to: '9999@c.us', body: 'sub', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_fb_4',
      data: { id: 'wa_fb_4', from: '1234@c.us', to: '9999@c.us', body: '1080p', type: 'text', timestamp: 6, isGroup: false, kind: 'individual', fromMe: false },
    });
    const fbCard = sentImages.at(-1).caption;
    assert.equal(fbCard.includes('*sub* 1080p: https://pahe.test/k3'), true, 'kiwi 1080p missing in fallback card');
    assert.equal(fbCard.includes('fell back'), true, 'fallback annotation missing');
    assert.equal(fbCard.includes('1080p unavailable for some links'), true, 'fallback note missing');

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
    assert.equal(sent.at(-1).text.includes('Choose *language*'), true, 'bare number did not advance group flow');

    // --- Admin commands: only the ADMIN_JIDS sender can use them ---

    // status
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_1',
      data: { id: 'wa_adm_1', from: ADMIN_JID, to: '9999@c.us', body: 'status', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('*Status:* ready'), true, 'admin status reply missing');

    // qr -> sent as a base64 image
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_2',
      data: { id: 'wa_adm_2', from: ADMIN_JID, to: '9999@c.us', body: 'qr', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    const qrImg = sentImages.at(-1);
    assert.equal(qrImg.media.base64, 'QUJD', 'qr base64 payload wrong');
    assert.equal(qrImg.media.mimetype, 'image/png', 'qr mimetype wrong');
    assert.equal(qrImg.caption.includes('Scan this QR'), true, 'qr caption wrong');

    // reload -> single webhook re-registration
    const regsBefore = webhookRegistrations.length;
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_3',
      data: { id: 'wa_adm_3', from: ADMIN_JID, to: '9999@c.us', body: 'reload', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Webhook: registered'), true, 'reload reply wrong');
    assert.equal(webhookRegistrations.length, regsBefore + 1, 'reload did not re-register webhook');

    // stats (admin-only); a non-admin "stats" falls through to an anime search
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_4',
      data: { id: 'wa_adm_4', from: ADMIN_JID, to: '9999@c.us', body: 'stats', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('*Messages seen:*'), true, 'admin stats reply missing');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_5',
      data: { id: 'wa_adm_5', from: '1234@c.us', to: '9999@c.us', body: 'stats', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Matches for "stats"'), true, 'non-admin "stats" should behave like a search');

    // admin commands in groups: prefix optional (sender auth)
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_6',
      data: { id: 'wa_adm_6', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: ADMIN_JID, body: 'flush', type: 'text', timestamp: 8, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Cleared all flow states'), true, 'admin flush in group missing');

    // allowlist info
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_7',
      data: { id: 'wa_adm_7', from: ADMIN_JID, to: '9999@c.us', body: 'allowlist', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Allowlist mode'), true, 'allowlist reply missing');

    // ban -> banned sender silently ignored (DM + group-jid ban)
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_8',
      data: { id: 'wa_adm_8', from: ADMIN_JID, to: '9999@c.us', body: 'ban 5555@c.us', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Banned'), true, 'ban reply missing');
    const bannedBefore = sent.length;
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_9',
      data: { id: 'wa_adm_9', from: '5555@c.us', to: '9999@c.us', body: '/help', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.length, bannedBefore, 'banned user was answered');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_10',
      data: { id: 'wa_adm_10', from: ADMIN_JID, to: '9999@c.us', body: 'ban 1234-1@g.us', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    const groupBannedBefore = sent.length;
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_11',
      data: { id: 'wa_adm_11', from: '1234-1@g.us', to: '1234@c.us', chatId: '1234-1@g.us', author: '1234@c.us', body: '/help', type: 'text', timestamp: 8, isGroup: true, kind: 'group', fromMe: false },
    });
    assert.equal(sent.length, groupBannedBefore, 'banned group was answered');

    // unban restores service
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_12',
      data: { id: 'wa_adm_12', from: ADMIN_JID, to: '9999@c.us', body: 'unban 5555', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_13',
      data: { id: 'wa_adm_13', from: '5555@c.us', to: '9999@c.us', body: '/help', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Anime Download Bot'), true, 'unbanned user still ignored');

    // broadcast reaches every known chat (DM + group + whoever messaged)
    const bcBefore = sent.length;
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_14',
      data: { id: 'wa_adm_14', from: ADMIN_JID, to: '9999@c.us', body: 'broadcast hello everyone', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    const bc = sent.slice(bcBefore);
    assert.equal(bc.some((m) => m.chatId === '1234@c.us' && m.text === 'hello everyone'), true, 'broadcast missed the DM chat');
    assert.equal(bc.some((m) => m.chatId === '1234-1@g.us' && m.text === 'hello everyone'), true, 'broadcast missed the group chat');
    assert.equal(sent.at(-1).text.includes('Broadcast sent to'), true, 'broadcast result summary missing');

    // help never lists admin commands
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_adm_15',
      data: { id: 'wa_adm_15', from: '1234@c.us', to: '9999@c.us', body: '/help', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('broadcast'), false, 'help leaks admin commands');

    // info <title>: details card with cover, then an episode reply starts the flow
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_info_1',
      data: { id: 'wa_info_1', from: '1234@c.us', to: '9999@c.us', body: 'info re zero', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    const infoImg = sentImages.at(-1);
    assert.equal(infoImg.caption.includes('Re:Zero Season 4'), true, 'info card title missing');
    assert.equal(infoImg.caption.includes('⭐ 90/100'), true, 'info card score missing');
    assert.equal(infoImg.caption.includes('White Fox'), true, 'info card studio missing');
    assert.equal(infoImg.caption.includes('episode number'), true, 'info card download hint missing');
    assert.equal(infoImg.media.url, 'https://img.test/cover-rezero.jpg', 'info card cover missing');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_info_2',
      data: { id: 'wa_info_2', from: '1234@c.us', to: '9999@c.us', body: '5', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Choose *language*'), true, 'info did not hand off to download flow');

    // User preferences: pref sub 720p makes the flow skip lang/quality steps
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_pref_1',
      data: { id: 'wa_pref_1', from: '1234@c.us', to: '9999@c.us', body: 'pref sub 720p', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Language: *sub*'), true, 'pref reply missing language');
    assert.equal(sent.at(-1).text.includes('Quality: *720p*'), true, 'pref reply missing quality');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_pref_2',
      data: { id: 'wa_pref_2', from: '1234@c.us', to: '9999@c.us', body: 'd re zero 2', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_pref_3',
      data: { id: 'wa_pref_3', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sentImages.at(-1).caption.includes('Episode 2 (sub, 720p)'), true, 'prefs did not skip lang/quality steps');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_pref_4',
      data: { id: 'wa_pref_4', from: '1234@c.us', to: '9999@c.us', body: 'pref', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Language: *sub*'), true, 'pref status missing');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_pref_5',
      data: { id: 'wa_pref_5', from: '1234@c.us', to: '9999@c.us', body: 'pref none', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Cleared your preferences'), true, 'pref clear missing');

    // Subscriptions: sub -> pick -> confirm, subs list, poller alert, unsub
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_sub_1',
      data: { id: 'wa_sub_1', from: '1234@c.us', to: '9999@c.us', body: 'sub re zero', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Matches for "re zero"'), true, 'sub did not search');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_sub_2',
      data: { id: 'wa_sub_2', from: '1234@c.us', to: '9999@c.us', body: '1', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    const subConfirmText = sent.at(-1).text;
    assert.equal(subConfirmText.includes('Subscribed to *Re:Zero Season 4*'), true, 'sub confirm missing');
    assert.equal(subConfirmText.includes('episode 7'), true, 'sub confirm latest episode wrong');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_sub_3',
      data: { id: 'wa_sub_3', from: '1234@c.us', to: '9999@c.us', body: 'subs', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    const subsMsg = [...sent].reverse().find((m) => m.text?.includes('Subscriptions for this chat'));
    assert.equal(subsMsg?.text.includes('1. *Re:Zero Season 4*'), true, 'subs list missing entry');

    // The poller (SUB_POLL_MS=1000) notices the stub airing info moved to ep 9 (latest 8)
    const alertDeadline = Date.now() + 8000;
    let subAlert = null;
    while (Date.now() < alertDeadline) {
      subAlert = sent.find((m) => m.chatId === '1234@c.us' && m.text?.includes('New episode alert') && m.text.includes('Episode 8'));
      if (subAlert) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(subAlert !== null, true, 'subscription alert never arrived');
    assert.equal(subAlert.text.includes('d Re:Zero Season 4 8'), true, 'alert download hint missing');

    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_sub_4',
      data: { id: 'wa_sub_4', from: '1234@c.us', to: '9999@c.us', body: 'unsub 1', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('Removed *Re:Zero Season 4*'), true, 'unsub confirm missing');
    await postWebhook(`${base}/webhook`, {
      event: 'message.received',
      idempotencyKey: 'msg_sub_5',
      data: { id: 'wa_sub_5', from: '1234@c.us', to: '9999@c.us', body: 'subs', type: 'text', timestamp: 8, isGroup: false, kind: 'individual', fromMe: false },
    });
    assert.equal(sent.at(-1).text.includes('No subscriptions'), true, 'subs list not empty after unsub');

    // Bad signature rejected
    const bad = Buffer.from(JSON.stringify({ event: 'message.received', data: { body: 'x' } }));
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenWA-Signature': 'sha256=deadbeef' },
      body: bad,
    });
    assert.equal(res.status, 401, 'bad signature accepted');

    // --- Rate limiting: second bot instance with RATE_LIMIT_MS=3000 ---
    const BOT2_PORT = 3302;
    const bot2 = spawn('node', [BOT_ENTRY], {
      env: {
        ...process.env,
        BOT_PORT: String(BOT2_PORT),
        OPENWA_URL: `http://127.0.0.1:${OPENWA_PORT}`,
        OPENWA_API_KEY: 'test-key',
        WEBHOOK_SECRET: SECRET,
        OPENWA_PUBLIC_URL: `http://127.0.0.1:${BOT2_PORT}`,
        ANILIST_ENDPOINT: `http://127.0.0.1:${ANILIST_PORT}/`,
        NEKO_BASE_URL: `http://127.0.0.1:${NEKO_PORT}`,
        SEARCH_CACHE_TTL_MS: '60000',
        RATE_LIMIT_MS: '3000',
        ADMIN_DATA_FILE: path.join(os.tmpdir(), 'momo-smoke-admin2.json'),
        PREF_DATA_FILE: path.join(os.tmpdir(), 'momo-smoke-prefs2.json'),
        SUBS_DATA_FILE: path.join(os.tmpdir(), 'momo-smoke-subs2.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const base2 = `http://127.0.0.1:${BOT2_PORT}`;
      for (let i = 0; i < 50; i++) {
        try {
          const r = await fetch(`${base2}/health`);
          if (r.ok) break;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      await postWebhook(`${base2}/webhook`, {
        event: 'message.received',
        idempotencyKey: 'msg_rl_1',
        data: { id: 'wa_rl_1', from: '7777@c.us', to: '9999@c.us', body: 're zero', type: 'text', timestamp: 9, isGroup: false, kind: 'individual', fromMe: false },
      });
      assert.equal(sent.at(-1).text.includes('Matches for "re zero"'), true, 'rate-limited first request failed');
      await postWebhook(`${base2}/webhook`, {
        event: 'message.received',
        idempotencyKey: 'msg_rl_2',
        data: { id: 'wa_rl_2', from: '7777@c.us', to: '9999@c.us', body: 'one piece', type: 'text', timestamp: 9, isGroup: false, kind: 'individual', fromMe: false },
      });
      assert.equal(sent.at(-1).text.includes('Slow down'), true, 'rate limiter did not block second request');
    } finally {
      bot2.kill('SIGKILL');
    }

    // Webhook auto-registration happened (either bot instance)
    assert.equal(webhookRegistrations.length >= 1, true, 'webhook auto-registration missing');
    assert.equal(
      webhookRegistrations.some((w) => w.url === `http://127.0.0.1:${BOT_PORT}/webhook`),
      true,
      'main bot webhook not registered',
    );

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