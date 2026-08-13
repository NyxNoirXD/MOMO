// Minimal HTTP + WebSocket reverse proxy for the single-container deployment.
// Routes:
//   /webhook*        -> bot (BOT_PORT)
//   /health          -> bot
//   everything else  -> OpenWA (OPENWA_PORT)  [dashboard, /api, /mcp, /socket.io]
const http = require('node:http');
const net = require('node:net');

const BOT_PORT = Number(process.env.BOT_PORT || 3001);
const OPENWA_PORT = Number(process.env.OPENWA_PORT || 2790);
const ROUTER_PORT = Number(process.env.PORT || 2785);
const BOT_HOST = process.env.BOT_HOST || '127.0.0.1';
const OPENWA_HOST = process.env.OPENWA_HOST || '127.0.0.1';

function targetFor(req) {
  const path = req.url.split('?')[0];
  if (path === '/webhook' || path.startsWith('/webhook/') || path === '/health') {
    return { host: BOT_HOST, port: BOT_PORT };
  }
  return { host: OPENWA_HOST, port: OPENWA_PORT };
}

const server = http.createServer((req, res) => {
  const target = targetFor(req);
  const proxyReq = http.request(
    {
      host: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end(`proxy error: ${err.message}`);
  });
  req.pipe(proxyReq);
});

server.on('upgrade', (req, socket, head) => {
  const target = targetFor(req);
  const upstream = net.connect(target.port, target.host, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    if (head && head.length) {
      upstream.write(head);
    }
  });
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.pipe(upstream);
  upstream.pipe(socket);
});

server.listen(ROUTER_PORT, () => {
  console.log(`[router] listening on :${ROUTER_PORT} (bot:${BOT_HOST}:${BOT_PORT}, openwa:${OPENWA_HOST}:${OPENWA_PORT})`);
});