import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { ProviderAuthService, extractAccountIdFromToken, extractEmailFromToken } from "./provider-auth-service.js";
import type { RemoteControlRecorder } from "../control-events.js";
import type { ProviderId, ProviderLoginMethod } from "../types/runtime.js";

const execFileAsync = promisify(execFile);

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const DEFAULT_CALLBACK_PORT = 1455;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

type FetchLike = typeof fetch;

interface OAuthTokens {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface DeviceAuthorizationResponse {
  device_auth_id: string;
  user_code: string;
  interval: string;
}

interface DeviceAuthorizationTokenResponse {
  authorization_code: string;
  code_verifier: string;
}

export interface AuthStatusResult {
  provider: ProviderId;
  authMode: "oauth";
  expiresAt?: number;
  accountId?: string;
  email?: string;
  method?: ProviderLoginMethod;
  source?: "project-store";
  state: "missing" | "stored" | "expired" | "refreshable";
}

export interface AuthLoginParams {
  provider: ProviderId;
  method?: ProviderLoginMethod;
  notify?: (message: string) => Promise<void> | void;
  prompt?: (message: string) => Promise<string>;
}

export interface AuthLogoutParams {
  provider: ProviderId;
}

export interface AuthLoginResult {
  ok: boolean;
  provider: ProviderId;
  method: ProviderLoginMethod;
  message: string;
  accountId?: string;
  email?: string;
  expiresAt?: number;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes)
    .map((value) => chars[value % chars.length] ?? "A")
    .join("");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(64);
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

function buildAuthorizeUrl(redirectUri: string, pkce: { verifier: string; challenge: string }, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "nanoclaw-multiruntime"
  });
  return `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(
  fetchImpl: FetchLike,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<OAuthTokens> {
  const response = await fetchImpl(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: verifier
    }).toString()
  });

  if (!response.ok) {
    throw new Error(`OpenAI OAuth token exchange failed: ${response.status}`);
  }

  return (await response.json()) as OAuthTokens;
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }
  if (platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }

  await execFileAsync("xdg-open", [url]);
}

function parseAuthorizationCode(input: string, expectedState: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Authorization code is required");
  }

  if (!trimmed.includes("://")) {
    return trimmed;
  }

  const url = new URL(trimmed);
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("Redirect URL is missing code");
  }
  const actualState = url.searchParams.get("state");
  if (!actualState) {
    throw new Error("Redirect URL is missing state");
  }
  if (actualState !== expectedState) {
    throw new Error("OAuth state mismatch");
  }

  return code;
}

export async function createReadlinePrompt(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return await rl.question(`${message} `);
  } finally {
    rl.close();
  }
}

function formatTlsHint(hostname: string): string {
  return `Unable to establish a trusted TLS connection to ${hostname}. Check proxy/firewall settings and install a valid CA chain inside Docker if needed.`;
}

async function runTlsPreflight(fetchImpl: FetchLike, url: string): Promise<void> {
  const hostname = new URL(url).hostname;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    });
    void response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/certificate|tls|ssl|issuer/i.test(message)) {
      throw new Error(formatTlsHint(hostname));
    }

    throw new Error(`Failed to reach ${hostname}: ${message}`);
  }
}

class OAuthCallbackServer {
  private server: http.Server | undefined;

  public async listen(
    port: number,
    state: string
  ): Promise<{ redirectUri: string; waitForCode: () => Promise<string>; close: () => Promise<void> }> {
    let resolveCode: ((value: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    this.server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (requestUrl.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const actualState = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error_description") ?? requestUrl.searchParams.get("error");

      if (error) {
        rejectCode?.(new Error(error));
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization failed</h1><p>You can close this window.</p></body></html>");
        return;
      }

      if (!code) {
        rejectCode?.(new Error("Missing authorization code"));
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization failed</h1><p>Missing authorization code.</p></body></html>");
        return;
      }

      if (actualState !== state) {
        rejectCode?.(new Error("OAuth state mismatch"));
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Authorization failed</h1><p>Invalid state.</p></body></html>");
        return;
      }

      resolveCode?.(code);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>");
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, () => resolve());
    });

    return {
      redirectUri: `http://localhost:${port}/auth/callback`,
      waitForCode: async () =>
        await Promise.race([
          codePromise,
          sleep(OAUTH_CALLBACK_TIMEOUT_MS).then(() => {
            throw new Error("OAuth callback timed out");
          })
        ]),
      close: async () => {
        if (!this.server) {
          return;
        }

        const server = this.server;
        this.server = undefined;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    };
  }
}

export class OpenAICodexAuthService {
  public constructor(
    private readonly providerAuth: ProviderAuthService,
    private readonly remoteControl: RemoteControlRecorder,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  public async login(params: AuthLoginParams): Promise<AuthLoginResult> {
    if (params.provider !== "openai-codex") {
      throw new Error(`Unsupported provider: ${params.provider}`);
    }

    const method = params.method ?? "oauth";
    await this.preflight();
    return method === "device" ? await this.loginWithDevice(params) : await this.loginWithOAuth(params);
  }

  public status(provider: ProviderId = "openai-codex"): AuthStatusResult {
    const row = this.providerAuth.status().find((item) => item.provider === provider);
    if (!row || row.authMode !== "oauth") {
      return {
        provider,
        authMode: "oauth",
        state: "missing"
      };
    }

    return {
      provider: row.provider,
      authMode: "oauth",
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      ...(row.accountId ? { accountId: row.accountId } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(row.method ? { method: row.method } : {}),
      ...(row.source ? { source: row.source } : {}),
      state: row.state
    };
  }

  public logout(params: AuthLogoutParams): { ok: boolean; message: string } {
    this.providerAuth.clear(params.provider);
    this.remoteControl.record("info", "Cleared provider auth", {
      provider: params.provider
    });
    return {
      ok: true,
      message: `Logged out ${params.provider}`
    };
  }

  private async preflight(): Promise<void> {
    try {
      await runTlsPreflight(this.fetchImpl, `${OPENAI_OAUTH_ISSUER}/oauth/authorize`);
      await runTlsPreflight(this.fetchImpl, "https://chatgpt.com/backend-api/codex/responses");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.remoteControl.record("error", "OpenAI Codex auth preflight failed", { message });
      throw new Error(message);
    }
  }

  private async loginWithOAuth(params: AuthLoginParams): Promise<AuthLoginResult> {
    const notify = async (message: string): Promise<void> => {
      await params.notify?.(message);
    };

    const prompt = params.prompt;
    const state = generateState();
    const pkce = await generatePkce();
    const callbackServer = new OAuthCallbackServer();
    let redirectUri = "";
    let waitForCode: (() => Promise<string>) | undefined;
    let closeServer: (() => Promise<void>) | undefined;

    try {
      try {
        const callback = await callbackServer.listen(DEFAULT_CALLBACK_PORT, state);
        redirectUri = callback.redirectUri;
        waitForCode = callback.waitForCode;
        closeServer = callback.close;
      } catch (error) {
        this.remoteControl.record("warn", "OAuth callback server unavailable, falling back to manual code input", {
          error: error instanceof Error ? error.message : String(error)
        });
      }

      const authorizeUrl = buildAuthorizeUrl(
        redirectUri || `http://localhost:${DEFAULT_CALLBACK_PORT}/auth/callback`,
        pkce,
        state
      );
      await notify(
        closeServer
          ? [
              "Open the following URL in your browser to log in to OpenAI Codex:",
              authorizeUrl,
              "If the callback does not complete automatically, paste the authorization code or full redirect URL."
            ].join("\n")
          : [
              "Unable to start a localhost callback server.",
              "Open the following URL in your browser, then paste the authorization code or full redirect URL:",
              authorizeUrl
            ].join("\n")
      );

      try {
        await openBrowser(authorizeUrl);
      } catch (error) {
        this.remoteControl.record("warn", "Failed to open browser for OAuth login", {
          error: error instanceof Error ? error.message : String(error)
        });
      }

      let code: string;
      try {
        code = waitForCode ? await waitForCode() : "";
      } catch {
        code = "";
      }

      if (!code) {
        if (!prompt) {
          throw new Error(
            "OAuth callback did not complete automatically; rerun through the CLI auth command to paste the redirect URL."
          );
        }
        const input = await prompt("Paste the authorization code (or full redirect URL):");
        code = parseAuthorizationCode(input, state);
      }

      const tokens = await exchangeCodeForTokens(
        this.fetchImpl,
        code,
        redirectUri || `http://localhost:${DEFAULT_CALLBACK_PORT}/auth/callback`,
        pkce.verifier
      );

      const accessToken = tokens.access_token;
      const idToken = tokens.id_token ?? accessToken;
      const accountId = extractAccountIdFromToken(idToken);
      const email = extractEmailFromToken(idToken);
      const credential = this.providerAuth.setOAuthCredential({
        provider: "openai-codex",
        accessToken,
        refreshToken: tokens.refresh_token,
        ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
        method: "oauth"
      });

      this.remoteControl.record("info", "Completed OpenAI Codex OAuth login", {
        provider: "openai-codex",
        method: "oauth",
        accountId
      });

      return {
        ok: true,
        provider: "openai-codex",
        method: "oauth",
        message: `Logged in to openai-codex via OAuth${email ? ` as ${email}` : ""}`,
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
        ...(credential.email ? { email: credential.email } : {}),
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {})
      };
    } finally {
      if (closeServer) {
        await closeServer().catch(() => undefined);
      }
    }
  }

  private async loginWithDevice(params: AuthLoginParams): Promise<AuthLoginResult> {
    const notify = async (message: string): Promise<void> => {
      await params.notify?.(message);
    };

    const response = await this.fetchImpl(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "nanoclaw-multiruntime/0.1.0"
      },
      body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID })
    });

    if (!response.ok) {
      throw new Error(`Failed to initiate OpenAI Codex device login: ${response.status}`);
    }

    const device = (await response.json()) as DeviceAuthorizationResponse;
    const intervalMs = Math.max(Number.parseInt(device.interval, 10) || 5, 1) * 1000;
    await notify(
      [
        "Open the following URL to authorize OpenAI Codex:",
        `${OPENAI_OAUTH_ISSUER}/codex/device`,
        `Enter confirmation code: ${device.user_code}`
      ].join("\n")
    );

    while (true) {
      const poll = await this.fetchImpl(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "nanoclaw-multiruntime/0.1.0"
        },
        body: JSON.stringify({
          device_auth_id: device.device_auth_id,
          user_code: device.user_code
        })
      });

      if (poll.ok) {
        const payload = (await poll.json()) as DeviceAuthorizationTokenResponse;
        const tokens = await exchangeCodeForTokens(
          this.fetchImpl,
          payload.authorization_code,
          `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`,
          payload.code_verifier
        );
        const accessToken = tokens.access_token;
        const idToken = tokens.id_token ?? accessToken;
        const accountId = extractAccountIdFromToken(idToken);
        const email = extractEmailFromToken(idToken);
        const credential = this.providerAuth.setOAuthCredential({
          provider: "openai-codex",
          accessToken,
          refreshToken: tokens.refresh_token,
          ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
          ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
          ...(accountId ? { accountId } : {}),
          ...(email ? { email } : {}),
          method: "device"
        });

        this.remoteControl.record("info", "Completed OpenAI Codex device login", {
          provider: "openai-codex",
          method: "device",
          accountId
        });

        return {
          ok: true,
          provider: "openai-codex",
          method: "device",
          message: `Logged in to openai-codex via device flow${email ? ` as ${email}` : ""}`,
          ...(credential.accountId ? { accountId: credential.accountId } : {}),
          ...(credential.email ? { email: credential.email } : {}),
          ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {})
        };
      }

      let errorPayload: Record<string, unknown> | null = null;
      try {
        errorPayload = (await poll.json()) as Record<string, unknown>;
      } catch {
        errorPayload = null;
      }

      const errorCode =
        typeof errorPayload?.error === "string"
          ? errorPayload.error
          : typeof errorPayload?.code === "string"
            ? errorPayload.code
            : undefined;

      if (errorCode === "authorization_pending" || poll.status === 403 || poll.status === 404) {
        await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS);
        continue;
      }
      if (errorCode === "slow_down") {
        await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS + 5_000);
        continue;
      }
      if (errorCode === "expired_token") {
        throw new Error("OpenAI Codex device login expired before authorization completed");
      }

      throw new Error(`OpenAI Codex device login failed: ${poll.status}`);
    }
  }
}
