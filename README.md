# MOMO — Anime Download Bot for WhatsApp

WhatsApp bot that returns anime episode **download links** via the
[Nekostream mapping API](.api_doc). Uses [OpenWA](https://github.com/rmyndharis/OpenWA)
(a self-hosted WhatsApp API gateway, Baileys engine) for WhatsApp connectivity, and
[AniList](https://anilist.co) to resolve anime titles to MAL IDs.

## How it works

```
WhatsApp user ──► OpenWA (Baileys, gateway) ──webhook──► Bot (this repo)
        ▲                                                │
        │                                                ▼
        └────────────── send-text reply ◄──── OpenWA REST API ◄── anilist + nekostream
```

- **Bot** receives `message.received` webhooks (HMAC-verified), runs a per-chat
  conversation state machine, and replies through OpenWA's REST API with a quoted reply.
- **Quick command**: `d <title> <episode>` (e.g. `d one piece 1087`, or a range like `d one piece 1080-1090`)
- **Multi-step**: send an anime name → numbered list → episode or range → **sub/dub** → quality → link card
  with **all servers** (Kiwi / gogoanime / anivibe) for the chosen language at the chosen quality.
- Ranges are capped at **24 episodes** per request; the bot fetches them sequentially and replies
  with a single combined card containing only the chosen language, so multi-episode requests don't
  flood the chat.
- Other commands: `help`, `menu`, `cancel`.

## Project layout

```
bot/                    # the bot (TypeScript, Express)
  src/
    index.ts            # HTTP server: /webhook (HMAC), /health, webhook auto-registration
    webhook.ts          # signature verification + idempotency dedupe
    brain.ts            # per-chat conversation state machine
    anilist.ts          # title -> MAL ID (cached GraphQL search)
    nekostream.ts       # download-link API client
    openwaClient.ts     # OpenWA REST client (send-text, webhooks)
    format.ts           # WhatsApp message formatting
  test/smoke.mjs        # end-to-end test with stubbed OpenWA/anilist/nekostream
deploy/                 # single-container deployment (Dockerfile, router, start.sh, backup)
scripts/                # provisioning helpers (session, webhook, API sanity)
docker-compose.yml      # local dev
```

## Quick start (local)

```bash
npm --prefix bot install && npm --prefix bot run build
npm --prefix bot test                      # smoke test (no WhatsApp needed)

docker compose up -d --build
# open http://localhost:2785 -> create session "momo" -> scan QR (Linked Devices)
# then register the webhook (from another terminal):
docker compose exec momo cat /app/data/.api-key   # grab the API key
OPENWA_API_KEY=<key> OPENWA_PUBLIC_URL=http://localhost:2785 \
  WEBHOOK_SECRET=$(openssl rand -hex 32) ./scripts/register-webhook.sh
```

`scripts/create-session.sh` does the same from the CLI and saves the QR to `qr.png`.

## Deploying on Render (free tier)

The whole stack (OpenWA + bot + router) runs in **one container**, because the free
plan allows ~750 instance-hours/month — enough for exactly one always-awake service.

1. **Push this repo to GitHub** and set the `repo:` field in `deploy/render.yaml`.
2. Render → **New → Blueprint** → connect the repo.
3. Set env vars:
   - `OPENWA_PUBLIC_URL` = `https://<service>.onrender.com`
   - `WEBHOOK_SECRET` = `openssl rand -hex 32`
   - `BACKUP_REMOTE` = `b2:momo-backup` + `RCLONE_CONFIG_B2_ACCOUNT`/`RCLONE_CONFIG_B2_KEY`
     ([Backblaze B2](https://www.backblaze.com/cloud-storage) free tier: 10 GB, no card needed).
4. Add a free **UptimeRobot** monitor pinging `https://<service>.onrender.com/health`
   every 5 minutes — this stops Render's 15-minute idle sleep.
5. Open `https://<service>.onrender.com/` → create the **momo** session → scan the QR.
   The bot auto-registers its webhook (retries until the session exists).
6. DM the bot an anime name on WhatsApp. 🎉

### Why the backup matters

Render's free disk is **ephemeral** — every restart/redeploy wipes it. Baileys stores
WhatsApp credentials as **files** (`/app/data/baileys`), not in the database, so without
backups you would re-scan the QR after every restart. The container's `start.sh`
restores the latest backup from B2 on boot and uploads a fresh one every 15 minutes
(plus a graceful catch-up on SIGTERM). **Scan the QR once, keep it forever.**

### Known limitations (free tier)

- The container sleeps after ~15 min without inbound traffic; with the UptimeRobot
  ping it stays warm. Messages sent in the few seconds during a cold start are missed.
- 512 MB RAM is tight: heap is capped (`--max-old-space-size=256`), Baileys is the
  lightweight engine, and the router is a ~50-line proxy. If you hit OOM restarts,
  the same image runs fine on Oracle Cloud Always Free (Ampere A1, 2 OCPU/12 GB) —
  `docker build --build-arg ARCH=arm64 .` and run with a named volume.
- Render may restart free services at any time; backup/restore makes that transparent.

## Env vars

See [.env.example](.env.example) for the full list with comments.

## Commands the bot understands

| Input | Behavior |
|---|---|
| `help` / `menu` | Command list |
| `d <title> <ep>` | Quick download, e.g. `d one piece 1087` |
| `d <title> <start>-<end>` | Quick range download, e.g. `d one piece 1080-1090` (max 24) |
| `<anime name>` (DM) | Search and start the pick flow |
| `<number>` | Select match / episode / quality (depends on flow step) |
| `5-8` | Episode range (max 24 episodes per request) |
| `sub` / `dub` | Language choice (one per request - prevents link flooding) |
| `360p` / `720p` / `1080p` | Quality choice |
| `cancel` | Abort the current flow |

**In groups** the bot only responds to prefixed commands (`/help`, `!d one piece 1087`,
`/cancel`) — bare anime names and messages are ignored so it doesn't spam chat. The
prefixes are configurable via `GROUP_COMMAND_PREFIXES` (default `/!`); numbers, ranges
and sub/dub/quality replies keep advancing an already-started flow. Flows are scoped per
sender, so no one can hijack another member's download. In DMs prefixes are optional.

## Disclaimer

Unofficial WhatsApp automation carries a small risk of account restriction — use a
dedicated number. Download links are for personal use only; respect the rights of
content owners.
