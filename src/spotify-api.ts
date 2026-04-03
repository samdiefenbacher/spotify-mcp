import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";

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
  tokenStorePath?: string;
};

type TokenState = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  source:
    | "env"
    | "manual"
    | "pkce"
    | "refresh"
    | "client_credentials"
    | "authorization_code"
    | "store";
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

type PersistedUserToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  updatedAt: string;
};

type LocalAuthSession = {
  authorizationUrl: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  startedAt: number;
  server: Server;
  completion: Promise<Record<string, unknown>>;
};

export class SpotifyApiClient {
  private readonly config: SpotifyConfig;
  private readonly availableScopes: string[];
  private readonly pkceSessions = new Map<string, PkceSession>();
  private localAuthSession?: LocalAuthSession;
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
      tokenStorePath: this.getTokenStorePath(),
      pendingPkceSessions: this.pkceSessions.size,
      pendingLocalAuth: this.localAuthSession
        ? {
            redirectUri: this.localAuthSession.redirectUri,
            scopes: this.localAuthSession.scopes,
            state: this.localAuthSession.state,
            startedAt: new Date(this.localAuthSession.startedAt).toISOString(),
          }
        : null,
    };
  }

  async beginUserAuth(input: {
    redirectUri?: string;
    scopes?: string[];
    state?: string;
    showDialog?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error(
        "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required to start local user auth.",
      );
    }

    if (this.localAuthSession) {
      return {
        authorizationUrl: this.localAuthSession.authorizationUrl,
        redirectUri: this.localAuthSession.redirectUri,
        scopes: this.localAuthSession.scopes,
        state: this.localAuthSession.state,
        startedAt: new Date(this.localAuthSession.startedAt).toISOString(),
        status: "pending",
      };
    }

    const redirectUri = input.redirectUri ?? this.config.defaultRedirectUri;
    const redirectUrl = parseLoopbackRedirectUri(redirectUri);
    const scopes =
      input.scopes && input.scopes.length > 0 ? input.scopes : this.availableScopes;
    const state = input.state ?? randomBytes(12).toString("hex");
    const authorizationUrl = new URL("https://accounts.spotify.com/authorize");

    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", this.config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);

    if (input.showDialog === true) {
      authorizationUrl.searchParams.set("show_dialog", "true");
    }

    let resolveCompletion!: (value: Record<string, unknown>) => void;
    let rejectCompletion!: (reason?: unknown) => void;
    const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    completion.catch(() => undefined);
    const server = createServer((request, response) => {
      void this.handleLocalAuthCallback({
        requestUrl: request.url ?? "/",
        redirectUri,
        expectedPath: redirectUrl.pathname,
        expectedState: state,
        respond: (statusCode, body) => {
          response.statusCode = statusCode;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(body);
        },
        resolveCompletion,
        rejectCompletion,
      });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(Number(redirectUrl.port), redirectUrl.hostname, () => {
        server.off("error", rejectPromise);
        resolvePromise();
      });
    });

    this.localAuthSession = {
      authorizationUrl: authorizationUrl.toString(),
      redirectUri,
      scopes,
      state,
      startedAt: Date.now(),
      server,
      completion,
    };

    return {
      authorizationUrl: authorizationUrl.toString(),
      redirectUri,
      scopes,
      state,
      status: "pending",
      instructions:
        "Open the authorizationUrl in your browser, approve the app, and wait for Spotify to redirect back to the local callback URL.",
    };
  }

  async awaitUserAuth(input?: {
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.localAuthSession) {
      if (this.userToken) {
        return {
          status: "authenticated",
          userToken: {
            source: this.userToken.source,
            hasRefreshToken: Boolean(this.userToken.refreshToken),
            expiresAt: this.userToken.expiresAt
              ? new Date(this.userToken.expiresAt).toISOString()
              : null,
            scopes: this.userToken.scopes ?? null,
          },
        };
      }

      throw new Error("No local user auth session is pending.");
    }

    const timeoutMs = clampTimeoutMs(input?.timeoutMs);

    const timed = await Promise.race([
      this.localAuthSession.completion,
      new Promise<Record<string, unknown>>((resolve) => {
        setTimeout(() => {
          const session = this.localAuthSession;
          resolve({
            status: "pending",
            redirectUri: session?.redirectUri ?? null,
            scopes: session?.scopes ?? null,
            state: session?.state ?? null,
          });
        }, timeoutMs);
      }),
    ]);

    return timed;
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
    this.persistUserToken(this.userToken);

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
    this.persistUserToken(this.userToken);

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
      "No Spotify credentials are configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, or complete an auth flow such as spotify.begin-user-auth.",
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
          "A user token is required for this endpoint. Start spotify.begin-user-auth or configure a refresh token.",
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

    const refreshedToken: TokenState = {
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
    this.persistUserToken(refreshedToken);

    return refreshedToken;
  }

  private createInitialUserToken(): TokenState | undefined {
    const persistedToken = this.readPersistedUserToken();
    const accessToken = this.config.accessToken ?? persistedToken?.accessToken;
    const refreshToken = this.config.refreshToken ?? persistedToken?.refreshToken;
    const expiresAt =
      parseExpiresAt(this.config.accessTokenExpiresAt) ?? persistedToken?.expiresAt;
    const scopes = parseScopes(this.config.tokenScopes) ?? persistedToken?.scopes;

    if (!accessToken && !refreshToken) {
      return undefined;
    }

    return {
      accessToken: accessToken ?? "",
      refreshToken,
      expiresAt,
      scopes,
      source:
        this.config.accessToken !== undefined || this.config.refreshToken !== undefined
          ? "env"
          : "store",
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

  private async handleLocalAuthCallback(input: {
    requestUrl: string;
    redirectUri: string;
    expectedPath: string;
    expectedState: string;
    respond: (statusCode: number, body: string) => void;
    resolveCompletion: (value: Record<string, unknown>) => void;
    rejectCompletion: (reason?: unknown) => void;
  }): Promise<void> {
    const requestUrl = new URL(input.requestUrl, input.redirectUri);

    if (requestUrl.pathname !== input.expectedPath) {
      input.respond(404, renderHtmlResponse("Not found", "Unknown callback path."));
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const state = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");

    if (error) {
      const failure = new Error(`Spotify authorization failed: ${error}`);
      input.respond(
        400,
        renderHtmlResponse("Authorization failed", `Spotify returned: ${error}`),
      );
      this.finishLocalAuthSession();
      input.rejectCompletion(failure);
      return;
    }

    if (!code) {
      const failure = new Error("Spotify authorization callback did not include a code.");
      input.respond(
        400,
        renderHtmlResponse("Authorization failed", "Spotify did not return a code."),
      );
      this.finishLocalAuthSession();
      input.rejectCompletion(failure);
      return;
    }

    if (state !== input.expectedState) {
      const failure = new Error("Spotify authorization state mismatch.");
      input.respond(
        400,
        renderHtmlResponse(
          "Authorization failed",
          "The returned state value did not match the expected request.",
        ),
      );
      this.finishLocalAuthSession();
      input.rejectCompletion(failure);
      return;
    }

    try {
      const token = await this.exchangeAuthorizationCode({
        code,
        redirectUri: input.redirectUri,
      });

      this.userToken = token;
      this.persistUserToken(token);
      input.respond(
        200,
        renderHtmlResponse(
          "Spotify connected",
          "Authorization completed successfully. You can close this tab.",
        ),
      );
      input.resolveCompletion({
        status: "authenticated",
        source: token.source,
        hasRefreshToken: Boolean(token.refreshToken),
        accessTokenExpiresAt: token.expiresAt
          ? new Date(token.expiresAt).toISOString()
          : null,
        scopes: token.scopes ?? null,
        tokenStorePath: this.getTokenStorePath(),
      });
    } catch (error) {
      input.respond(
        500,
        renderHtmlResponse(
          "Authorization failed",
          error instanceof Error ? error.message : "Unknown error",
        ),
      );
      input.rejectCompletion(error);
    } finally {
      this.finishLocalAuthSession();
    }
  }

  private async exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<TokenState> {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.config.clientId}:${this.config.clientSecret}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        `Failed to exchange authorization code: ${formatErrorPayload(payload)}`,
      );
    }

    return {
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
          : undefined,
      source: "authorization_code",
    };
  }

  private finishLocalAuthSession(): void {
    const session = this.localAuthSession;

    this.localAuthSession = undefined;
    session?.server.close();
  }

  private readPersistedUserToken(): PersistedUserToken | undefined {
    const tokenStorePath = this.getTokenStorePath();

    if (!tokenStorePath || !existsSync(tokenStorePath)) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(readFileSync(tokenStorePath, "utf8")) as Partial<PersistedUserToken>;

      if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
        if (typeof parsed.refreshToken === "string" && parsed.refreshToken.length > 0) {
          return {
            accessToken: "",
            refreshToken: parsed.refreshToken,
            expiresAt:
              typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
            scopes: Array.isArray(parsed.scopes)
              ? parsed.scopes.filter((scope): scope is string => typeof scope === "string")
              : undefined,
            updatedAt:
              typeof parsed.updatedAt === "string"
                ? parsed.updatedAt
                : new Date(0).toISOString(),
          };
        }

        return undefined;
      }

      return {
        accessToken: parsed.accessToken,
        refreshToken:
          typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
        scopes: Array.isArray(parsed.scopes)
          ? parsed.scopes.filter((scope): scope is string => typeof scope === "string")
          : undefined,
        updatedAt:
          typeof parsed.updatedAt === "string"
            ? parsed.updatedAt
            : new Date(0).toISOString(),
      };
    } catch (error) {
      throw new Error(
        `Failed to read Spotify token store at ${tokenStorePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private persistUserToken(token: TokenState): void {
    const tokenStorePath = this.getTokenStorePath();

    if (!tokenStorePath) {
      return;
    }

    mkdirSync(dirname(tokenStorePath), { recursive: true });
    writeFileSync(
      tokenStorePath,
      JSON.stringify(
        {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          scopes: token.scopes,
          updatedAt: new Date().toISOString(),
        } satisfies PersistedUserToken,
        null,
        2,
      ),
      "utf8",
    );
  }

  private getTokenStorePath(): string | undefined {
    return this.config.tokenStorePath
      ? resolve(this.config.tokenStorePath)
      : undefined;
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

function parseLoopbackRedirectUri(redirectUri: string): URL {
  const url = new URL(redirectUri);
  const validHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

  if (url.protocol !== "http:") {
    throw new Error("Local user auth requires an http:// localhost redirect URI.");
  }

  if (!validHosts.has(url.hostname)) {
    throw new Error(
      "Local user auth requires a loopback redirect URI such as http://127.0.0.1:8888/callback.",
    );
  }

  if (!url.port) {
    throw new Error("Local user auth requires an explicit port in the redirect URI.");
  }

  return url;
}

function renderHtmlResponse(title: string, message: string): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{font-family:system-ui,Segoe UI,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#111827;background:#f9fafb;}",
    "main{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1.5rem 1.25rem;box-shadow:0 10px 25px rgba(0,0,0,.06);}",
    "h1{margin-top:0;font-size:1.4rem;}",
    "p{margin-bottom:0;}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(message)}</p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clampTimeoutMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 120_000;
  }

  return Math.max(1_000, Math.min(Math.trunc(value), 600_000));
}

function formatErrorPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}
