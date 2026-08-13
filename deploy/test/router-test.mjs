// Router integration test: verifies /webhook + /health route to the bot, / and /api
// route to OpenWA, and a WebSocket upgrade tunnels to OpenWA.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const BOT_PORT = 3311;
const OPENWA_PORT = 3312;
const ROUTER_PORT = 3313;

function start(name, port, handler) {
  const server = http.createServer(handler);
  server.listen(port, '127.0.0.1');
  return { server, name };
}

async function main() {
  const bot = start('bot', BOT_PORT, (req, res) => {
    if (req.url === '/health') return res.end('bot-health');
    if (req.url === '/webhook') return res.end('bot-webhook');
    res.end('bot-other');
  });
  const openwa = start('openwa', OPENWA_PORT, (req, res) => {
    if (req.url === '/api/sessions') return res.end('openwa-api');
    res.end('openwa-page');
  });
  openwa.server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  await Promise.all([once(bot.server, 'listening'), once(openwa.server, 'listening')]);

  const router = spawn('node', ['deploy/router.js'], {
    env: { ...process.env, PORT: String(ROUTER_PORT), BOT_PORT: String(BOT_PORT), OPENWA_PORT: String(OPENWA_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  router.stdout.on('data', (d) => process.stdout.write(`[router] ${d}`));
  router.stderr.on('data', (d) => process.stdout.write(`[router-err] ${d}`));
  try {
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${ROUTER_PORT}/health`);
        if (r.ok) break;
      } catch {
        /* not up */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const health = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/health`)).text();
    assert.equal(health, 'bot-health', 'health not routed to bot');

    const webhook = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/webhook`, { method: 'POST' })).text();
    assert.equal(webhook, 'bot-webhook', 'webhook not routed to bot');

    const api = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/api/sessions`)).text();
    assert.equal(api, 'openwa-api', '/api not routed to openwa');

    const page = await (await fetch(`http://127.0.0.1:${ROUTER_PORT}/`)).text();
    assert.equal(page, 'openwa-page', 'root not routed to openwa');

    // WebSocket upgrade through the router
    const ws = await new Promise((resolve, reject) => {
      const sock = net.connect(ROUTER_PORT, '127.0.0.1', () => {
        sock.write(
          'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          sock.destroy();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('ws upgrade timeout')), 3000);
    });
    assert.match(ws, /101 Switching Protocols/, 'ws upgrade failed');

    console.log('\nROUTER TEST PASSED: routing + ws upgrade green');
  } finally {
    router.kill('SIGKILL');
    bot.server.close();
    openwa.server.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ROUTER TEST FAILED:', err);
    process.exit(1);
  });