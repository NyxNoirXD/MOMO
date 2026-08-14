import fs from 'node:fs';
import express from 'express';
import { loadConfig } from './config.js';
import { AniListClient } from './anilist.js';
import { NekoStreamClient } from './nekostream.js';
import { BotBrain } from './brain.js';
import { OpenWaClient } from './openwaClient.js';
import { AdminService } from './admin.js';
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
        return key;
      }
    }
  }
  return '';
}

/** Single registration attempt - used both by the retry loop and the admin `reload` command. */
async function registerWebhookOnce(
  openwa: OpenWaClient,
  publicUrl: string,
  secret: string,
): Promise<string> {
  const webhookUrl = `${publicUrl.replace(/\/+$/, '')}/webhook`;
  const existing = await openwa.listWebhooks();
  if (existing.some((w) => w.url === webhookUrl && w.active)) {
    return 'already registered';
  }
  await openwa.createWebhook(webhookUrl, secret);
  return 'registered';
}

async function ensureWebhookRegistered(
  openwa: OpenWaClient,
  publicUrl: string,
  secret: string,
  log: (msg: string) => void,
): Promise<void> {
  const webhookUrl = `${publicUrl.replace(/\/+$/, '')}/webhook`;
  log(`ensuring webhook ${webhookUrl} is registered (retries until success)...`);
  // Retry forever: OpenWA may still be booting, the API key may not exist yet,
  // or the session may not have been created in the dashboard. The API key is
  // re-read on every attempt, so a late-created /app/data/.api-key is picked up.
  for (let attempt = 1; ; attempt++) {
    try {
      log(`webhook ${await registerWebhookOnce(openwa, publicUrl, secret)}`);
      return;
    } catch (err) {
      if (attempt === 1 || attempt % 10 === 0) {
        log(`webhook registration pending (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const openwa = new OpenWaClient(
    config.openwaUrl,
    () => resolveApiKey(config.openwaApiKey),
    config.openwaSessionName,
  );
  const admin = new AdminService(
    config.adminJids,
    config.allowlistEnabled,
    config.broadcastMax,
    config.adminDataFile,
  );
  const brain = new BotBrain(
    new AniListClient(config.searchCacheTtlMs, config.anilistEndpoint),
    new NekoStreamClient(config.nekoBaseUrl),
    config.stateTtlMs,
    config.groupCommandPrefixes,
    admin,
    openwa,
    async () => {
      if (!config.publicUrl || !config.webhookSecret) {
        return 'auto-registration disabled (set OPENWA_PUBLIC_URL + WEBHOOK_SECRET)';
      }
      return registerWebhookOnce(openwa, config.publicUrl, config.webhookSecret);
    },
  );

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });
  app.use('/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  app.post('/webhook', createWebhookHandler(brain, openwa, config.webhookSecret, log));

  app.listen(config.port, () => {
    log(`bot listening on :${config.port}`);
    log(`admin JIDs: ${config.adminJids.length ? config.adminJids.join(', ') : 'NONE (no admin commands active)'}`);
    if (config.allowlistEnabled) {
      log('allowlist mode ENFORCED - only allowlisted users are answered');
    }
    if (resolveApiKey(config.openwaApiKey)) {
      log('OpenWA API key: configured');
    } else {
      log('WARNING: no OpenWA API key - set OPENWA_API_KEY or mount /app/data/.api-key');
    }
    if (config.publicUrl && config.webhookSecret) {
      void ensureWebhookRegistered(openwa, config.publicUrl, config.webhookSecret, log);
    } else {
      log('webhook auto-registration disabled (set OPENWA_PUBLIC_URL + WEBHOOK_SECRET)');
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});