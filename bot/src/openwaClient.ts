export interface SendTextOptions {
  quotedMessageId?: string;
  mentions?: string[];
}

export class OpenWaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OpenWaError';
  }
}

export class OpenWaClient {
  private sessionId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly getApiKey: () => string,
    private readonly sessionName: string,
  ) {}

  async resolveSessionId(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }
    const sessions = (await this.request('/api/sessions')) as Array<{
      id: string;
      name: string;
    }>;
    const found = sessions.find((s) => s.name === this.sessionName);
    if (!found) {
      const available = sessions.map((s) => s.name).join(', ') || 'none yet';
      throw new OpenWaError(`session "${this.sessionName}" not found (available: ${available})`, 404);
    }
    this.sessionId = found.id;
    return found.id;
  }

  async sendText(chatId: string, text: string, opts: SendTextOptions = {}): Promise<unknown> {
    const sessionId = await this.resolveSessionId();
    return this.request(`/api/sessions/${sessionId}/messages/send-text`, {
      method: 'POST',
      body: {
        chatId,
        text,
        linkPreview: true,
        ...(opts.quotedMessageId ? { quotedMessageId: opts.quotedMessageId } : {}),
        ...(opts.mentions && opts.mentions.length ? { mentions: opts.mentions } : {}),
      },
    });
  }

  async sendImage(
    chatId: string,
    url: string,
    caption: string,
    opts: SendTextOptions = {},
  ): Promise<unknown> {
    const sessionId = await this.resolveSessionId();
    return this.request(`/api/sessions/${sessionId}/messages/send-image`, {
      method: 'POST',
      body: {
        chatId,
        media: { url },
        caption,
        ...(opts.quotedMessageId ? { quotedMessageId: opts.quotedMessageId } : {}),
      },
    });
  }

  async sendImageData(
    chatId: string,
    base64: string,
    mimetype: string,
    caption: string,
    opts: SendTextOptions = {},
  ): Promise<unknown> {
    const sessionId = await this.resolveSessionId();
    return this.request(`/api/sessions/${sessionId}/messages/send-image`, {
      method: 'POST',
      body: {
        chatId,
        media: { base64, mimetype },
        caption,
        ...(opts.quotedMessageId ? { quotedMessageId: opts.quotedMessageId } : {}),
      },
    });
  }

  async getSessionStatus(): Promise<{
    id: string;
    name: string;
    status: string;
    phone?: string | null;
    pushName?: string | null;
    connectedAt?: string | null;
    lastActive?: string | null;
  } | null> {
    const sessions = (await this.request('/api/sessions')) as Array<{
      id: string;
      name: string;
      status: string;
      phone?: string | null;
      pushName?: string | null;
      connectedAt?: string | null;
      lastActive?: string | null;
    }>;
    return sessions.find((s) => s.name === this.sessionName) ?? null;
  }

  async getSessionQr(): Promise<{ qrCode: string; status: string } | null> {
    const sessionId = await this.resolveSessionId();
    return (await this.request(`/api/sessions/${sessionId}/qr`)) as {
      qrCode: string;
      status: string;
    } | null;
  }

  async listWebhooks(sessionId?: string): Promise<Array<{ id: string; url: string; active: boolean }>> {
    const id = sessionId ?? (await this.resolveSessionId());
    return (await this.request(`/api/sessions/${id}/webhooks`)) as Array<{
      id: string;
      url: string;
      active: boolean;
    }>;
  }

  async createWebhook(
    url: string,
    secret: string,
    sessionId?: string,
  ): Promise<unknown> {
    const id = sessionId ?? (await this.resolveSessionId());
    return this.request(`/api/sessions/${id}/webhooks`, {
      method: 'POST',
      body: { url, events: ['message.received'], secret, retryCount: 3 },
    });
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const apiKey = this.getApiKey();
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Auth/not-found failures may mean a stale session cache or a key that has
      // since rotated/appeared - forget the cache so the next call re-resolves.
      if (res.status === 401 || res.status === 404) {
        this.sessionId = null;
      }
      const text = await res.text().catch(() => '');
      throw new OpenWaError(
        `OpenWA ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    if (res.status === 204) {
      return null;
    }
    return res.json().catch(() => null);
  }
}