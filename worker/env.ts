// Minimal Cloudflare runtime types (kept local so the project type-checks without @cloudflare/workers-types).

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<unknown>;
}

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface Env {
  /** Ingest and processing are opt-in. Secrets map connection IDs to independent machine tokens. */
  INBOX_INGEST_ENABLED?: string;
  INBOX_INGEST_KEYS?: string | Record<string, unknown>;
  DB: D1Database;
  ASSETS?: Fetcher;
  /** JSON key of a Google service account with read-only access to the spreadsheet. Secret. */
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  /** Set to "0" only for plain-http local development where Secure cookies are impossible. */
  COOKIE_SECURE?: string;
  /** Test hook: overrides fetch used for Google APIs. Never set in production. */
  __FETCH?: typeof fetch;
}
