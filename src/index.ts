import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { loadSpotifyOpenApi, OperationDefinition } from "./openapi.js";
import { SpotifyApiClient } from "./spotify-api.js";

loadDotenvFile();

const server = new McpServer({
  name: "spotify-mcp",
  version: "0.1.0",
});

const schemaPath = process.env.SPOTIFY_OPENAPI_SCHEMA ?? "spotify-openapi.yaml";
const { operations, availableScopes } = loadSpotifyOpenApi(schemaPath);
const spotify = new SpotifyApiClient(
  {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    accessToken: process.env.SPOTIFY_ACCESS_TOKEN,
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
    accessTokenExpiresAt: process.env.SPOTIFY_ACCESS_TOKEN_EXPIRES_AT,
    tokenScopes: process.env.SPOTIFY_TOKEN_SCOPES,
    defaultRedirectUri:
      process.env.SPOTIFY_DEFAULT_REDIRECT_URI ?? "http://127.0.0.1:8888/callback",
  },
  availableScopes,
);

server.registerTool(
  "spotify.auth-status",
  {
    description: "Report the currently configured Spotify auth state.",
  },
  async () => asTextResult(spotify.getAuthStatus()),
);

server.registerTool(
  "spotify.begin-pkce-auth",
  {
    description:
      "Create a Spotify PKCE authorization URL. Open the returned URL, approve the app, then pass the code to spotify.complete-pkce-auth.",
    inputSchema: z.object({
      redirectUri: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      state: z.string().optional(),
    }),
  },
  async ({ redirectUri, scopes, state }) =>
    asTextResult(spotify.beginPkceAuth({ redirectUri, scopes, state })),
);

server.registerTool(
  "spotify.complete-pkce-auth",
  {
    description:
      "Exchange a Spotify authorization code for user tokens using a previously created PKCE session.",
    inputSchema: z.object({
      sessionId: z.string(),
      code: z.string(),
    }),
  },
  async ({ sessionId, code }) =>
    asTextResult(await spotify.completePkceAuth({ sessionId, code })),
);

server.registerTool(
  "spotify.set-user-tokens",
  {
    description:
      "Inject Spotify access and optional refresh tokens into the running server. This only persists until restart.",
    inputSchema: z.object({
      accessToken: z.string(),
      refreshToken: z.string().optional(),
      expiresInSeconds: z.number().int().positive().optional(),
      scopes: z.array(z.string()).optional(),
    }),
  },
  async ({ accessToken, refreshToken, expiresInSeconds, scopes }) =>
    asTextResult(
      spotify.setUserTokens({
        accessToken,
        refreshToken,
        expiresInSeconds,
        scopes,
      }),
    ),
);

server.registerTool(
  "spotify.list-operations",
  {
    description:
      "List generated Spotify MCP operations from the bundled OpenAPI schema.",
    inputSchema: z.object({
      tag: z.string().optional(),
      search: z.string().optional(),
      includeDeprecated: z.boolean().optional(),
    }),
  },
  async ({ tag, search, includeDeprecated }) => {
    const filtered = operations.filter((operation) => {
      if (!includeDeprecated && operation.deprecated) {
        return false;
      }

      if (tag && !operation.tags.includes(tag)) {
        return false;
      }

      if (search) {
        const haystack = [
          operation.toolName,
          operation.summary,
          operation.description ?? "",
          operation.path,
          operation.tags.join(" "),
        ]
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(search.toLowerCase())) {
          return false;
        }
      }

      return true;
    });

    return asTextResult({
      totalOperations: operations.length,
      matchingOperations: filtered.length,
      operations: filtered.map((operation) => summarizeOperation(operation)),
    });
  },
);

server.registerTool(
  "spotify.api-request",
  {
    description:
      "Send a raw request to the Spotify Web API path under /v1. Use this for endpoints not yet reflected in your client UI.",
    inputSchema: z.object({
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      path: z.string(),
      query: z.record(z.string(), z.any()).optional(),
      body: z.any().optional(),
      requireUserAuth: z.boolean().optional(),
      scopes: z.array(z.string()).optional(),
      contentType: z.string().optional(),
    }),
  },
  async ({ method, path, query, body, requireUserAuth, scopes, contentType }) =>
    asTextResult(
      await spotify.request({
        method,
        path,
        query,
        body,
        requireUserAuth,
        requiredScopes: scopes,
        contentType,
      }),
    ),
);

for (const operation of operations) {
  registerGeneratedOperation(operation);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `spotify-mcp connected over stdio with ${operations.length} generated Spotify operations.`,
  );
}

function registerGeneratedOperation(operation: OperationDefinition): void {
  server.registerTool(
    operation.toolName,
    {
      description: buildOperationDescription(operation),
      inputSchema: operation.inputSchema,
    },
    async (args) => {
      const input = (args ?? {}) as Record<string, unknown>;
      let resolvedPath = operation.path;
      const query: Record<string, unknown> = {};

      for (const parameter of operation.parameters) {
        const value = input[parameter.argName];

        if (value === undefined) {
          continue;
        }

        if (parameter.in === "path") {
          resolvedPath = resolvedPath.replace(
            `{${parameter.name}}`,
            encodeURIComponent(String(value)),
          );
          continue;
        }

        query[parameter.name] = value;
      }

      const response = await spotify.request({
        method: operation.method,
        path: resolvedPath,
        query,
        body: operation.requestBody ? input.body : undefined,
        contentType: operation.requestBody?.contentType,
        requireUserAuth: operation.requiredScopes.length > 0,
        requiredScopes: operation.requiredScopes,
      });

      return asTextResult(response);
    },
  );
}

function buildOperationDescription(operation: OperationDefinition): string {
  const lines = [
    operation.summary,
    `${operation.method.toUpperCase()} ${operation.path}`,
    operation.requiredScopes.length > 0
      ? `Required scopes: ${operation.requiredScopes.join(", ")}`
      : "Required scopes: none beyond a valid bearer token",
    operation.deprecated ? "Deprecated in Spotify's schema." : undefined,
    operation.description,
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function summarizeOperation(operation: OperationDefinition): Record<string, unknown> {
  return {
    toolName: operation.toolName,
    method: operation.method.toUpperCase(),
    path: operation.path,
    summary: operation.summary,
    tags: operation.tags,
    deprecated: operation.deprecated,
    requiredScopes: operation.requiredScopes,
  };
}

function asTextResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function loadDotenvFile(): void {
  const envPath = ".env";

  if (!existsSync(envPath)) {
    return;
  }

  const parsed = dotenv.parse(readFileSync(envPath));

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error("spotify-mcp failed:", error);
  process.exit(1);
});
