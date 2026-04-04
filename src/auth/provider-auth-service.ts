import type { AppConfig } from "../config/index.js";
import type {
  ProviderCredential,
  ProviderId,
  ProviderLoginMethod,
  ProviderOAuthCredential,
  ProviderAuthSource
} from "../types/runtime.js";

interface ProviderAuthStorage {
  getProviderAuth(providerId: ProviderId): Record<string, unknown> | null;
  upsertProviderAuth(providerId: ProviderId, credential: Record<string, unknown>): void;
  clearProviderAuth(providerId: ProviderId): void;
  listProviderAuth(): Array<{ providerId: string; credential: Record<string, unknown> }>;
}

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payloadPart = parts[1];
  if (!payloadPart) {
    return null;
  }

  try {
    const payloadRaw = Buffer.from(payloadPart, "base64url").toString("utf8");
    return JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeJwtExpiryMs(token: string): number | null {
  const claims = decodeJwtClaims(token);
  return typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
}

export function extractAccountIdFromToken(token: string): string | undefined {
  const claims = decodeJwtClaims(token);
  if (!claims) {
    return undefined;
  }

  if (typeof claims.chatgpt_account_id === "string" && claims.chatgpt_account_id) {
    return claims.chatgpt_account_id;
  }

  const nested = claims["https://api.openai.com/auth"];
  if (isRecord(nested) && typeof nested.chatgpt_account_id === "string" && nested.chatgpt_account_id) {
    return nested.chatgpt_account_id;
  }

  const organizations = claims.organizations;
  if (Array.isArray(organizations) && isRecord(organizations[0]) && typeof organizations[0].id === "string") {
    return organizations[0].id;
  }

  return undefined;
}

export function extractEmailFromToken(token: string): string | undefined {
  const claims = decodeJwtClaims(token);
  return typeof claims?.email === "string" && claims.email ? claims.email : undefined;
}

function normalizeStoredCredential(providerId: ProviderId, raw: Record<string, unknown> | null): ProviderCredential | null {
  if (!raw) {
    return null;
  }

  if (raw.type === "api-key" && typeof raw.apiKey === "string" && raw.apiKey) {
    return {
      type: "api-key",
      provider: providerId,
      apiKey: raw.apiKey
    };
  }

  if (
    raw.type === "oauth" &&
    typeof raw.accessToken === "string" &&
    typeof raw.refreshToken === "string" &&
    typeof raw.expiresAt === "number"
  ) {
    const credential: ProviderOAuthCredential = {
      type: "oauth",
      provider: providerId,
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken,
      expiresAt: raw.expiresAt
    };

    if (typeof raw.accountId === "string" && raw.accountId) {
      credential.accountId = raw.accountId;
    }
    if (typeof raw.email === "string" && raw.email) {
      credential.email = raw.email;
    }
    if (typeof raw.idToken === "string" && raw.idToken) {
      credential.idToken = raw.idToken;
    }
    if ((raw.method === "oauth" || raw.method === "device") && typeof raw.method === "string") {
      credential.method = raw.method as ProviderLoginMethod;
    }
    if (raw.source === "project-store") {
      credential.source = raw.source as ProviderAuthSource;
    }

    return credential;
  }

  return null;
}

export class ProviderAuthService {
  public constructor(
    private readonly storage: ProviderAuthStorage,
    private readonly _config: AppConfig
  ) {}

  public get(providerId: ProviderId): ProviderCredential | null {
    return normalizeStoredCredential(providerId, this.storage.getProviderAuth(providerId));
  }

  public set(credential: ProviderCredential): void {
    this.storage.upsertProviderAuth(credential.provider, credential as unknown as Record<string, unknown>);
  }

  public setOAuthCredential(input: {
    provider: ProviderId;
    accessToken: string;
    refreshToken: string;
    expiresAt?: number;
    idToken?: string;
    accountId?: string;
    email?: string;
    method: ProviderLoginMethod;
  }): ProviderOAuthCredential {
    const credential: ProviderOAuthCredential = {
      type: "oauth",
      provider: input.provider,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt ?? decodeJwtExpiryMs(input.accessToken) ?? Date.now() + 60 * 60 * 1000,
      method: input.method,
      source: "project-store"
    };

    if (input.accountId) {
      credential.accountId = input.accountId;
    }
    if (input.email) {
      credential.email = input.email;
    }
    if (input.idToken) {
      credential.idToken = input.idToken;
    }

    this.set(credential);
    return credential;
  }

  public clear(providerId: ProviderId): void {
    this.storage.clearProviderAuth(providerId);
  }

  public async refreshIfNeeded(providerId: ProviderId): Promise<ProviderCredential | null> {
    const credential = this.get(providerId);
    if (!credential || credential.type !== "oauth") {
      return credential;
    }

    if (credential.expiresAt > Date.now() + 30_000) {
      return credential;
    }

    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: OPENAI_OAUTH_CLIENT_ID
      }).toString()
    });

    if (!response.ok) {
      throw new Error(`OAuth token refresh failed for ${providerId}: ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = String(payload.access_token ?? "");
    const refreshToken = String(payload.refresh_token ?? credential.refreshToken);
    const refreshed: ProviderOAuthCredential = {
      type: "oauth",
      provider: providerId,
      accessToken,
      refreshToken,
      expiresAt:
        decodeJwtExpiryMs(accessToken) ??
        (Date.now() +
          (typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600) * 1000),
      method: credential.method ?? "oauth",
      source: "project-store"
    };

    const accountId = extractAccountIdFromToken(String(payload.id_token ?? accessToken)) ?? credential.accountId;
    const email = extractEmailFromToken(String(payload.id_token ?? accessToken)) ?? credential.email;
    if (accountId) {
      refreshed.accountId = accountId;
    }
    if (email) {
      refreshed.email = email;
    }
    const idToken = typeof payload.id_token === "string" && payload.id_token ? payload.id_token : credential.idToken;
    if (idToken) {
      refreshed.idToken = idToken;
    }
    this.set(refreshed);
    return refreshed;
  }

  public status(): Array<{
    provider: ProviderId;
    authMode: "api-key" | "oauth";
    expiresAt?: number;
    accountId?: string;
    email?: string;
    method?: ProviderLoginMethod;
    source?: ProviderAuthSource;
    state: "missing" | "stored" | "expired" | "refreshable";
  }> {
    const rows = this.storage.listProviderAuth();
    return rows
      .map(({ providerId, credential }) => normalizeStoredCredential(providerId as ProviderId, credential))
      .filter((credential): credential is ProviderCredential => credential !== null)
      .map((credential) => {
        if (credential.type === "api-key") {
          return {
            provider: credential.provider,
            authMode: "api-key" as const,
            state: "stored" as const
          };
        }

        const expiresAt = credential.expiresAt;
        let state: "stored" | "expired" | "refreshable" = "stored";
        if (expiresAt <= Date.now()) {
          state = credential.refreshToken ? "refreshable" : "expired";
        }

        return {
          provider: credential.provider,
          authMode: "oauth" as const,
          expiresAt,
          ...(credential.accountId ? { accountId: credential.accountId } : {}),
          ...(credential.email ? { email: credential.email } : {}),
          ...(credential.method ? { method: credential.method } : {}),
          source: credential.source ?? "project-store",
          state
        };
      });
  }
}
