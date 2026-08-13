import fs from 'node:fs';
import express from 'express';
import { loadConfig } from './config.js';
import { AniListClient } from './anilist.js';
import { NekoStreamClient } from './nekostream.js';
import { BotBrain } from './brain.js';
import { OpenWaClient } from './openwaClient.js';
import { createWebhookHandler } from './webhook.js';

function log(msg: string): void {
  console.log(`[momo] ${new Date().toISOString()} ${msg}`);
}

function resolveApiKey(configured: string): string {
  if (configured) {
    return configured;
  }
  for (const candidate of [
    '/app/data/.api-key',
    'data/.api-key',
    process.env.OPENWA_DATA_DIR ? `${process.env.OPENWA_DATA_DIR}/.api-key` : '',
  ]) {
    if (candidate && fs.existsSync(candidate)) {
      const key = fs.readFileSync(candidate, 'utf8').trim();
      if (key) {
        log(`auto-discovered OpenWA API key from ${candidate}`);
        return key;
      }
    }
  }
  return '';
}

async function ensureWebhookRegistered(
  openwa: OpenWaClient,
  publicUrl: string,
  secret: string,
): Promise<void> {
  const webhookUrl = `${publicUrl.replace(/\/+$/, '')}/webhook`;
  log(`ensuring webhook ${webhookUrl} is registered...`);
  for (let attempt = 1; ; attempt++) {
    try {
      const existing = await openwa.listWebhooks();
      if (existing.some((w) => w.url === webhookUrl && w.active)) {
        log('webhook already registered');
        return;
      }
      await openwa.createWebhook(webhookUrl, secret);
      log('webhook registered');
      return;
    } catch (err) {
      if (attempt >= 60) {
        log(`webhook registration giving up: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      log(
        `webhook registration pending (${attempt}/60): ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const apiKey = resolveApiKey(config.openwaApiKey);
  const openwa = new OpenWaClient(config.openwaUrl, apiKey, config.openwaSessionName);
  const brain = new BotBrain(
    new AniListClient(config.searchCacheTtlMs, config.anilistEndpoint),
    new NekoStreamClient(config.nekoBaseUrl),
    config.stateTtlMs,
    config.groupCommandPrefixes,
  );

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });
  app.use('/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  app.post('/webhook', createWebhookHandler(brain, openwa, config.webhookSecret, log));

  app.listen(config.port, () => {
    log(`bot listening on :${config.port}`);
    if (apiKey) {
      log('OpenWA API key: configured');
    } else {
      log('WARNING: no OpenWA API key - set OPENWA_API_KEY or mount /app/data/.api-key');
    }
    if (config.publicUrl && config.webhookSecret) {
      void ensureWebhookRegistered(openwa, config.publicUrl, config.webhookSecret);
    } else {
      log('webhook auto-registration disabled (set OPENWA_PUBLIC_URL + WEBHOOK_SECRET)');
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});