export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export class RoadmapError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const messages: Record<number, string> = {
  400: 'Roadmap отклонил параметры запроса.',
  401: 'Ключ Roadmap недействителен, отозван или просрочен. Владелец должен заменить секрет.',
  403: 'Действие запрещено ролью или разрешениями ключа Roadmap. Обход не допускается.',
  404: 'Объект не найден или недоступен владельцу ключа.',
  409: 'Данные изменились или требуется отдельное подтверждение. Прочитайте состояние и получите новое подтверждение пользователя.',
  429: 'Лимит Roadmap исчерпан. Подождите перед новым запросом; запись автоматически не повторяется.',
};
const safeCodes = new Set(['version_conflict', 'over_budget', 'approved', 'merged', 'confirm_disclose', 'invalid_api_key', 'rate_limited']);

export class Roadmap {
  constructor(private key: string, private fetcher: Fetch, private diagnostics = false) {}
  // Paths are constructed only by this adapter's callers; never accept a URL from a tool.
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\\#]/.test(path)) throw new Error('Invalid API path');
    const url = new URL(`https://products-roadmap.ezhirov-es.workers.dev/api${path}`);
    if (!url.pathname.startsWith('/api/')) throw new Error('Invalid API path');
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${this.key}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // Opt-in diagnostics only: never log request headers, JWTs, API keys, bodies, or stack traces.
      if (this.diagnostics) {
        const category = error instanceof Error ? error.name : 'UnknownError';
        const detail = error instanceof Error ? this.sanitize(error.message).slice(0, 200) : '';
        console.warn(JSON.stringify({ event: 'roadmap_transport_failed', category, detail }));
      }
      throw new RoadmapError(502, 'unknown_result', 'Roadmap не ответил. Результат записи неизвестен: не повторяйте её автоматически, сначала проверьте данные.');
    }
    let data: any;
    try { data = await response.json(); } catch {
      throw new RoadmapError(502, 'invalid_response', 'Некорректный ответ Roadmap. Результат записи может быть неизвестен; не повторяйте автоматически.');
    }
    if (!response.ok) {
      const code = data?.error?.code ?? data?.code ?? data?.error;
      throw new RoadmapError(response.status, safeCodes.has(code) ? code : `http_${response.status}`, messages[response.status] ?? 'Ошибка Roadmap. Запись автоматически не повторяется.');
    }
    return this.sanitize(data);
  }
  sanitize(value: any): any {
    if (typeof value === 'string') return value.split(this.key).join('[REDACTED]').replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]').replace(/rr_[a-z0-9]{8}_[A-Za-z0-9]{40}/g, '[REDACTED]');
    if (Array.isArray(value)) return value.map(v => this.sanitize(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(authorization|cookie|set-cookie|access_token|refresh_token|secret|token)$/i.test(k)).map(([k, v]) => [k, this.sanitize(v)]));
    return value;
  }
  task(id: string) { return this.request(`/features/${encodeURIComponent(id)}`); }
}
