import { createHash, randomBytes } from "node:crypto";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SpotifyConfig = {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  tokenScopes?: string;
  defaultRedirectUri: string;
};

type TokenState = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  source: "env" | "manual" | "pkce" | "refresh" | "client_credentials";
};

type PkceSession = {
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  state: string;
};

type SpotifyRequest = {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  contentType?: string;
  requireUserAuth?: boolean;
  requiredScopes?: string[];
};

export class SpotifyApiClient {
  private readonly config: SpotifyConfig;
  private readonly availableScopes: string[];
  private readonly pkceSessions = new Map<string, PkceSession>();
  private userToken?: TokenState;
  private appToken?: TokenState;

  constructor(config: SpotifyConfig, availableScopes: string[]) {
    this.config = config;
    this.availableScopes = availableScopes;
    this.userToken = this.createInitialUserToken();
  }

  getAuthStatus(): Record<string, unknown> {
    return {
      clientIdConfigured: Boolean(this.config.clientId),
      clientSecretConfigured: Boolean(this.config.clientSecret),
      defaultRedirectUri: this.config.defaultRedirectUri,
      availableScopes: this.availableScopes,
      userToken: this.userToken
        ? {
            source: this.userToken.source,
            hasRefreshToken: Boolean(this.userToken.refreshToken),
            expiresAt: this.userToken.expiresAt
              ? new Date(this.userToken.expiresAt).toISOString()
              : null,
            scopes: this.userToken.scopes ?? null,
          }
        : null,
      appToken: this.appToken
        ? {
            source: this.appToken.source,
            expiresAt: this.appToken.expiresAt
              ? new Date(this.appToken.expiresAt).toISOString()
              : null,
          }
        : null,
      pendingPkceSessions: this.pkceSessions.size,
    };
  }

  beginPkceAuth(input: {
    redirectUri?: string;
    scopes?: string[];
    state?: string;
  }): Record<string, unknown> {
    if (!this.config.clientId) {
      throw new Error("SPOTIFY_CLIENT_ID is required to start PKCE auth.");
    }

    const redirectUri = input.redirectUri ?? this.config.defaultRedirectUri;
    const scopes =
      input.scopes && input.scopes.length > 0 ? input.scopes : this.availableScopes;
    const sessionId = randomBytes(12).toString("hex");
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = input.state ?? sessionId;
    const authorizationUrl = new URL("https://accounts.spotify.com/authorize");

    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", this.config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("scope", scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);

    this.pkceSessions.set(sessionId, {
      codeVerifier,
      redirectUri,
      scopes,
      state,
    });

    return {
      sessionId,
      redirectUri,
      scopes,
      state,
      authorizationUrl: authorizationUrl.toString(),
    };
  }

  async completePkceAuth(input: {
    sessionId: string;
    code: string;
  }): Promise<Record<string, unknown>> {
    if (!this.config.clientId) {
      throw new Error("SPOTIFY_CLIENT_ID is required to complete PKCE auth.");
    }

    const session = this.pkceSessions.get(input.sessionId);

    if (!session) {
      throw new Error(`Unknown PKCE session: ${input.sessionId}`);
    }

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: session.redirectUri,
        code_verifier: session.codeVerifier,
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        `Failed to exchange authorization code: ${formatErrorPayload(payload)}`,
      );
    }

    this.userToken = {
      accessToken: String(payload.access_token),
      refreshToken:
        typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
      expiresAt:
        typeof payload.expires_in === "number"
          ? Date.now() + payload.expires_in * 1000
          : undefined,
      scopes:
        typeof payload.scope === "string"
          ? payload.scope.split(/\s+/).filter(Boolean)
          : session.scopes,
      source: "pkce",
    };

    this.pkceSessions.delete(input.sessionId);

    return {
      source: "pkce",
      accessTokenExpiresAt: this.userToken.expiresAt
        ? new Date(this.userToken.expiresAt).toISOString()
        : null,
      scopes: this.userToken.scopes ?? null,
      refreshToken: this.userToken.refreshToken ?? null,
    };
  }

  setUserTokens(input: {
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds?: number;
    scopes?: string[];
  }): Record<string, unknown> {
    this.userToken = {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt:
        typeof input.expiresInSeconds === "number"
          ? Date.now() + input.expiresInSeconds * 1000
          : undefined,
      scopes: input.scopes,
      source: "manual",
    };

    return this.getAuthStatus();
  }

  async request(input: SpotifyRequest): Promise<Record<string, unknown>> {
    return this.performRequest(input, false);
  }

  private async performRequest(
    input: SpotifyRequest,
    isRetry: boolean,
  ): Promise<Record<string, unknown>> {
    const accessToken = await this.getAccessToken(
      Boolean(input.requireUserAuth),
      input.requiredScopes ?? [],
    );
    const url = buildApiUrl(input.path, input.query);
    const contentType = input.contentType ?? "application/json";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    let body: BodyInit | undefined;

    if (input.body !== undefined) {
      if (contentType.includes("json")) {
        headers["Content-Type"] = contentType;
        body = JSON.stringify(input.body);
      } else if (
        contentType === "application/x-www-form-urlencoded" &&
        typeof input.body === "object" &&
        input.body !== null
      ) {
        headers["Content-Type"] = contentType;
        body = new URLSearchParams(
          Object.entries(input.body as Record<string, string>).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
      } else {
        headers["Content-Type"] = contentType;
        body = String(input.body);
      }
    }

    const response = await fetch(url, {
      method: input.method.toUpperCase(),
      headers,
      body,
    });

    if (
      response.status === 401 &&
      !isRetry &&
      (this.userToken?.refreshToken || this.canUseClientCredentials())
    ) {
      await this.refreshRelevantToken(Boolean(input.requireUserAuth));
      return this.performRequest(input, true);
    }

    const contentTypeHeader = response.headers.get("content-type") ?? "";
    const retryAfter = response.headers.get("retry-after");
    const responseBody = await parseResponseBody(response, contentTypeHeader);

    if (!response.ok) {
      const retryMessage = retryAfter ? ` Retry-After: ${retryAfter}s.` : "";

      throw new Error(
        `Spotify API ${response.status} ${response.statusText}: ${formatErrorPayload(responseBody)}.${retryMessage}`.trim(),
      );
    }

    return {
      status: response.status,
      path: url.pathname + url.search,
      data: responseBody,
    };
  }

  private async getAccessToken(
    requireUserAuth: boolean,
    requiredScopes: string[],
  ): Promise<string> {
    if (requireUserAuth || requiredScopes.length > 0) {
      const userToken = await this.getUserAccessToken(requiredScopes);
      return userToken.accessToken;
    }

    if (this.userToken) {
      const userToken = await this.getUserAccessToken([]);
      return userToken.accessToken;
    }

    if (this.canUseClientCredentials()) {
      const appToken = await this.getClientCredentialsToken();
      return appToken.accessToken;
    }

    throw new Error(
      "No Spotify credentials are configured. Set env vars or use spotify.begin-pkce-auth.",
    );
  }

  private async getUserAccessToken(requiredScopes: string[]): Promise<TokenState> {
    if (!this.userToken) {
      if (this.config.refreshToken) {
        this.userToken = {
          accessToken: this.config.accessToken ?? "",
          refreshToken: this.config.refreshToken,
          expiresAt: parseExpiresAt(this.config.accessTokenExpiresAt),
          scopes: parseScopes(this.config.tokenScopes),
          source: "env",
        };
      } else {
        throw new Error(
          "A user token is required for this endpoint. Configure a refresh token or complete PKCE auth.",
        );
      }
    }

    if (!this.userToken.accessToken || this.isExpired(this.userToken)) {
      this.userToken = await this.refreshUserToken(this.userToken);
    }

    if (
      requiredScopes.length > 0 &&
      this.userToken.scopes &&
      requiredScopes.some((scope) => !this.userToken?.scopes?.includes(scope))
    ) {
      throw new Error(
        `Configured user token is missing required scopes: ${requiredScopes.join(", ")}`,
      );
    }

    return this.userToken;
  }

  private async getClientCredentialsToken(): Promise<TokenState> {
    if (!this.canUseClientCredentials()) {
      throw new Error(
        "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required for client credentials auth.",
      );
    }

    if (this.appToken && !this.isExpired(this.appToken)) {
      return this.appToken;
    }

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.config.clientId}:${this.config.clientSecret}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
      }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        `Failed to obtain client credentials token: ${formatErrorPayload(payload)}`,
      );
    }

    this.appToken = {
      accessToken: String(payload.access_token),
      expiresAt:
        typeof payload.expires_in === "number"
          ? Date.now() + payload.expires_in * 1000
          : undefined,
      source: "client_credentials",
    };

    return this.appToken;
  }

  private async refreshRelevantToken(requireUserAuth: boolean): Promise<void> {
    if (requireUserAuth || this.userToken?.refreshToken) {
      if (!this.userToken) {
        throw new Error("No user token is available to refresh.");
      }

      this.userToken = await this.refreshUserToken(this.userToken);
      return;
    }

    if (this.canUseClientCredentials()) {
      this.appToken = undefined;
      await this.getClientCredentialsToken();
    }
  }

  private async refreshUserToken(currentToken: TokenState): Promise<TokenState> {
    if (!currentToken.refreshToken) {
      throw new Error(
        "The current user token cannot be refreshed. Configure SPOTIFY_REFRESH_TOKEN or re-authenticate.",
      );
    }

    if (!this.config.clientId) {
      throw new Error("SPOTIFY_CLIENT_ID is required to refresh a user token.");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentToken.refreshToken,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    if (this.config.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.config.clientId}:${this.config.clientSecret}`,
      ).toString("base64")}`;
    } else {
      body.set("client_id", this.config.clientId);
    }

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers,
      body,
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(`Failed to refresh user token: ${formatErrorPayload(payload)}`);
    }

    return {
      accessToken: String(payload.access_token),
      refreshToken:
        typeof payload.refresh_token === "string"
          ? payload.refresh_token
          : currentToken.refreshToken,
      expiresAt:
        typeof payload.expires_in === "number"
          ? Date.now() + payload.expires_in * 1000
          : undefined,
      scopes:
        typeof payload.scope === "string"
          ? payload.scope.split(/\s+/).filter(Boolean)
          : currentToken.scopes,
      source: "refresh",
    };
  }

  private createInitialUserToken(): TokenState | undefined {
    if (!this.config.accessToken && !this.config.refreshToken) {
      return undefined;
    }

    return {
      accessToken: this.config.accessToken ?? "",
      refreshToken: this.config.refreshToken,
      expiresAt: parseExpiresAt(this.config.accessTokenExpiresAt),
      scopes: parseScopes(this.config.tokenScopes),
      source: "env",
    };
  }

  private canUseClientCredentials(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private isExpired(token: TokenState): boolean {
    if (!token.expiresAt) {
      return false;
    }

    return Date.now() >= token.expiresAt - 60_000;
  }
}

function buildApiUrl(path: string, query?: Record<string, unknown>): URL {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://api.spotify.com/v1${normalizedPath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      url.searchParams.set(key, value.map(stringifyScalar).join(","));
      continue;
    }

    url.searchParams.set(key, stringifyScalar(value));
  }

  return url;
}

function stringifyScalar(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}

async function parseResponseBody(
  response: Response,
  contentType: string,
): Promise<JsonValue | string | null> {
  if (response.status === 204) {
    return null;
  }

  if (contentType.includes("application/json")) {
    return (await response.json()) as JsonValue;
  }

  return await response.text();
}

function parseExpiresAt(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const numeric = Number(value);

  if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
    return numeric;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function parseScopes(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const scopes = value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes.length > 0 ? scopes : undefined;
}

function formatErrorPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}
