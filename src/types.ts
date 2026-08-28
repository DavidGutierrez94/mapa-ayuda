export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_API_KEY?: string;
  KAPSO_API_KEY?: string;
  KAPSO_PHONE_ID?: string;
  KAPSO_WEBHOOK_SECRET?: string;
  SMSGATE_SIGNING_KEY?: string;
  SMSGATE_LOGIN?: string;
  SMSGATE_PASSWORD?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITEKEY?: string;
  /** Dev/local escape hatch: "1" lets web intake through when TURNSTILE_SECRET is unset. Never set in prod. */
  ALLOW_OPEN_INTAKE?: string;
  /** Server-side pepper for cédula HMAC (H-3). Set as a wrangler secret in prod. */
  CEDULA_PEPPER?: string;
  ADMIN_TOKEN?: string;
  MOD_TOKEN?: string;
  RESPONDER_TOKEN?: string;
  /** "OrgName:token,OtherOrg:token" */
  ORG_TOKENS?: string;
  /** Fine-grained PAT with issues:write; unset → feedback queues in mod_log */
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
}

/** Normalized inbound message from any chat channel. */
export interface RawReport {
  channel: "whatsapp" | "sms";
  providerId: string;
  sender: string;
  text: string;
  buttonId?: string;
}

/** Triaged fields ready to become a request row. */
export interface TriagedReport {
  need_type: string;
  urgency: number;
  description: string;
  location_raw: string | null;
  households: number;
  quantity?: string | null;
}

export interface PipelineReply {
  kind: "ask_confirm" | "created" | "confirmed" | "none";
  text: string;
  requestId?: number;
}
