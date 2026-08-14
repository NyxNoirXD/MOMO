import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { BotBrain, Incoming } from './brain.js';
import type { OpenWaClient } from './openwaClient.js';

const MAX_IDEMPOTENCY_KEYS = 2000;

export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface MessageEventData {
  id?: string;
  /** The conversation JID (contact, group, or broadcast) - authoritative for replies. */
  chatId?: string;
  /** For group messages: the group JID. For DMs: the contact JID. */
  from?: string;
  /** The session's own JID for inbound messages. */
  to?: string;
  /** Group sender JID for group messages. */
  author?: string;
  body?: string;
  type?: string;
  timestamp?: number;
  isGroup?: boolean;
  kind?: string;
  hasMedia?: boolean;
  fromMe?: boolean;
}

export function createWebhookHandler(
  brain: BotBrain,
  openwa: OpenWaClient,
  secret: string,
  log: (msg: string) => void,
) {
  const seen = new Set<string>();

  return async (req: Request, res: Response): Promise<void> => {
    if (!verifySignature(req.body as Buffer, req.header('x-openwa-signature'), secret)) {
      res.status(401).json({ ok: false, error: 'invalid signature' });
      return;
    }
    let envelope: {
      event?: string;
      idempotencyKey?: string;
      data?: MessageEventData;
    };
    try {
      envelope = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      res.status(400).json({ ok: false, error: 'invalid json' });
      return;
    }

    const idempotencyKey =
      (req.header('x-openwa-idempotency-key') as string | undefined) ?? envelope.idempotencyKey ?? '';
    if (idempotencyKey) {
      if (seen.has(idempotencyKey)) {
        res.json({ ok: true, deduped: true });
        return;
      }
      seen.add(idempotencyKey);
      if (seen.size > MAX_IDEMPOTENCY_KEYS) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
    }

    if (envelope.event !== 'message.received') {
      res.json({ ok: true, ignored: true });
      return;
    }

    const data = envelope.data ?? {};
    if (data.fromMe || data.type !== 'text' || !data.body) {
      res.json({ ok: true, ignored: true });
      return;
    }

    // OpenWA always reports the conversation JID as `chatId`; `from`/`to` are
    // chat-vs-self and NOT safe to use as a reply target (in groups `to` is the
    // bot's own number). Fall back to `from` for non-group chats only.
    const chatId = data.chatId ?? data.from;
    if (!chatId || data.kind === 'status' || chatId.endsWith('@broadcast')) {
      res.json({ ok: true, ignored: true });
      return;
    }

    const incoming: Incoming = {
      chatId,
      body: data.body,
      isGroup: Boolean(data.isGroup),
      author: data.author,
    };
    let reply;
    try {
      reply = await brain.handle(incoming);
    } catch (err) {
      log(`brain error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      reply = { text: 'Something went wrong on my side. Try again in a moment.' };
    }

    if (reply) {
      try {
        const quoted = { quotedMessageId: data.id };
        const maxCaption = 1024;
        if (reply.imageUrl) {
          let caption = reply.text;
          let extraText: string | undefined;
          if (caption.length > maxCaption) {
            const nl = caption.indexOf('\n');
            caption = nl === -1 ? caption.slice(0, maxCaption) : caption.slice(0, nl);
            extraText = reply.text;
          }
          try {
            await openwa.sendImage(chatId, reply.imageUrl, caption, quoted);
            if (extraText) {
              await openwa.sendText(chatId, extraText, quoted);
            }
          } catch (err) {
            log(`image send failed, falling back to text: ${err instanceof Error ? err.message : String(err)}`);
            await openwa.sendText(chatId, reply.text, quoted);
          }
        } else {
          await openwa.sendText(chatId, reply.text, quoted);
        }
      } catch (err) {
        log(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    res.json({ ok: true });
  };
}