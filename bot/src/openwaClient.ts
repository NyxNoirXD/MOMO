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
    private readonly apiKey: string,
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
      throw new OpenWaError(`session "${this.sessionName}" not found`, 404);
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
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
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