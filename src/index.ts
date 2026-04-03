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
const curatedToolNames = new Set(["spotify.create-playlist"]);
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

server.registerTool(
  "spotify.create-playlist",
  {
    description:
      "Create a playlist for the current user, optionally seeding it with initial tracks.",
    inputSchema: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      public: z.boolean().optional(),
      collaborative: z.boolean().optional(),
      initialTrackUris: z.array(z.string()).optional(),
      initialTrackIds: z.array(z.string()).optional(),
    }),
  },
  async ({
    name,
    description,
    public: isPublic,
    collaborative,
    initialTrackUris,
    initialTrackIds,
  }) => {
    const createResponse = await spotify.request({
      method: "POST",
      path: "/me/playlists",
      body: {
        name,
        description,
        public: isPublic,
        collaborative,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
    });

    const playlist = createResponse.data as Record<string, unknown>;
    const playlistId = getString(playlist.id, "playlist id");
    const seededUris = dedupeStrings([
      ...normalizeTrackUris(initialTrackUris),
      ...normalizeTrackIdsToUris(initialTrackIds),
    ]);
    let addResponse: Record<string, unknown> | null = null;

    if (seededUris.length > 0) {
      addResponse = await spotify.request({
        method: "POST",
        path: `/playlists/${encodeURIComponent(playlistId)}/tracks`,
        body: {
          uris: seededUris,
        },
        requireUserAuth: true,
        requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
      });
    }

    return asTextResult({
      playlist: summarizePlaylist(playlist),
      seededTrackCount: seededUris.length,
      addItemsResult: addResponse?.data ?? null,
    });
  },
);

server.registerTool(
  "spotify.add-tracks",
  {
    description:
      "Add tracks to a playlist using Spotify track URIs and/or raw Spotify track IDs.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
      trackUris: z.array(z.string()).optional(),
      trackIds: z.array(z.string()).optional(),
      position: z.number().int().min(0).optional(),
    }),
  },
  async ({ playlistId, trackUris, trackIds, position }) => {
    const uris = dedupeStrings([
      ...normalizeTrackUris(trackUris),
      ...normalizeTrackIdsToUris(trackIds),
    ]);

    if (uris.length === 0) {
      throw new Error("Provide at least one track URI or track ID.");
    }

    const response = await spotify.request({
      method: "POST",
      path: `/playlists/${encodeURIComponent(playlistId)}/tracks`,
      body: {
        uris,
        position,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
    });

    return asTextResult({
      playlistId,
      addedCount: uris.length,
      uris,
      snapshot: response.data,
    });
  },
);

server.registerTool(
  "spotify.search-and-add",
  {
    description:
      "Search Spotify for tracks and add the best matches to a playlist.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
      query: z.string().optional(),
      queries: z.array(z.string()).optional(),
      market: z.string().optional(),
      limitPerQuery: z.number().int().min(1).max(10).optional(),
      position: z.number().int().min(0).optional(),
      failOnMissing: z.boolean().optional(),
    }),
  },
  async ({
    playlistId,
    query,
    queries,
    market,
    limitPerQuery,
    position,
    failOnMissing,
  }) => {
    const searchTerms = dedupeStrings([
      ...(query ? [query] : []),
      ...(queries ?? []),
    ]);

    if (searchTerms.length === 0) {
      throw new Error("Provide `query` or `queries`.");
    }

    const maxResultsPerQuery = limitPerQuery ?? 1;
    const matches: Array<Record<string, unknown>> = [];
    const missing: string[] = [];
    const urisToAdd: string[] = [];

    for (const term of searchTerms) {
      const response = await spotify.request({
        method: "GET",
        path: "/search",
        query: {
          q: term,
          type: ["track"],
          limit: maxResultsPerQuery,
          market,
        },
      });

      const data = response.data as Record<string, unknown>;
      const tracksContainer = data.tracks as Record<string, unknown> | undefined;
      const items = Array.isArray(tracksContainer?.items)
        ? (tracksContainer.items as Array<Record<string, unknown>>)
        : [];

      if (items.length === 0) {
        missing.push(term);
        continue;
      }

      const selected = items.slice(0, maxResultsPerQuery);

      for (const track of selected) {
        const uri = getString(track.uri, "track uri");
        urisToAdd.push(uri);
        matches.push({
          query: term,
          track: summarizeTrack(track),
        });
      }
    }

    if (missing.length > 0 && failOnMissing) {
      throw new Error(`No search results for: ${missing.join(", ")}`);
    }

    if (urisToAdd.length === 0) {
      return asTextResult({
        playlistId,
        addedCount: 0,
        missingQueries: missing,
        matches,
      });
    }

    const addResponse = await spotify.request({
      method: "POST",
      path: `/playlists/${encodeURIComponent(playlistId)}/tracks`,
      body: {
        uris: dedupeStrings(urisToAdd),
        position,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
    });

    return asTextResult({
      playlistId,
      addedCount: dedupeStrings(urisToAdd).length,
      missingQueries: missing,
      matches,
      snapshot: addResponse.data,
    });
  },
);

server.registerTool(
  "spotify.get-my-playlists",
  {
    description:
      "Fetch the current user's playlists with a compact summary view by default.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ limit, offset, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: "/me/playlists",
      query: {
        limit: limit ?? 20,
        offset: offset ?? 0,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-read-private"],
    });

    const data = response.data as Record<string, unknown>;
    const items = Array.isArray(data.items)
      ? (data.items as Array<Record<string, unknown>>)
      : [];

    if (summaryOnly ?? true) {
      return asTextResult({
        total: data.total ?? items.length,
        limit: data.limit ?? limit ?? 20,
        offset: data.offset ?? offset ?? 0,
        items: items.map((playlist) => summarizePlaylist(playlist)),
      });
    }

    return asTextResult(data);
  },
);

server.registerTool(
  "spotify.update-playlist-details",
  {
    description:
      "Update a playlist's metadata such as name, description, public state, and collaborative flag.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      public: z.boolean().optional(),
      collaborative: z.boolean().optional(),
    }),
  },
  async ({ playlistId, name, description, public: isPublic, collaborative }) => {
    if (
      name === undefined &&
      description === undefined &&
      isPublic === undefined &&
      collaborative === undefined
    ) {
      throw new Error("Provide at least one playlist field to update.");
    }

    const response = await spotify.request({
      method: "PUT",
      path: `/playlists/${encodeURIComponent(playlistId)}`,
      body: {
        name,
        description,
        public: isPublic,
        collaborative,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
    });

    return asTextResult({
      playlistId,
      updated: true,
      response: response.data,
    });
  },
);

server.registerTool(
  "spotify.remove-tracks",
  {
    description:
      "Remove tracks from a playlist using Spotify track URIs and/or raw Spotify track IDs.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
      trackUris: z.array(z.string()).optional(),
      trackIds: z.array(z.string()).optional(),
      snapshotId: z.string().optional(),
    }),
  },
  async ({ playlistId, trackUris, trackIds, snapshotId }) => {
    const uris = dedupeStrings([
      ...normalizeTrackUris(trackUris),
      ...normalizeTrackIdsToUris(trackIds),
    ]);

    if (uris.length === 0) {
      throw new Error("Provide at least one track URI or track ID to remove.");
    }

    const response = await spotify.request({
      method: "DELETE",
      path: `/playlists/${encodeURIComponent(playlistId)}/items`,
      body: {
        items: uris.map((uri) => ({ uri })),
        snapshot_id: snapshotId,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
    });

    return asTextResult({
      playlistId,
      removedCount: uris.length,
      uris,
      snapshot: response.data,
    });
  },
);

server.registerTool(
  "spotify.replace-tracks",
  {
    description:
      "Replace the full contents of a playlist with the supplied tracks. Pass an empty array to clear it.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
      trackUris: z.array(z.string()).optional(),
      trackIds: z.array(z.string()).optional(),
    }),
  },
  async ({ playlistId, trackUris, trackIds }) => {
    const uris = dedupeStrings([
      ...normalizeTrackUris(trackUris),
      ...normalizeTrackIdsToUris(trackIds),
    ]);

    const response = await spotify.request({
      method: "PUT",
      path: `/playlists/${encodeURIComponent(playlistId)}/items`,
      body: {
        uris,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
    });

    return asTextResult({
      playlistId,
      replacementCount: uris.length,
      uris,
      snapshot: response.data,
    });
  },
);

server.registerTool(
  "spotify.reorder-tracks",
  {
    description:
      "Move a contiguous range of playlist items to a new position.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
      rangeStart: z.number().int().min(0),
      insertBefore: z.number().int().min(0),
      rangeLength: z.number().int().min(1).optional(),
      snapshotId: z.string().optional(),
    }),
  },
  async ({ playlistId, rangeStart, insertBefore, rangeLength, snapshotId }) => {
    const response = await spotify.request({
      method: "PUT",
      path: `/playlists/${encodeURIComponent(playlistId)}/items`,
      body: {
        range_start: rangeStart,
        insert_before: insertBefore,
        range_length: rangeLength,
        snapshot_id: snapshotId,
      },
      requireUserAuth: true,
      requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
    });

    return asTextResult({
      playlistId,
      moved: {
        rangeStart,
        insertBefore,
        rangeLength: rangeLength ?? 1,
      },
      snapshot: response.data,
    });
  },
);

for (const operation of operations) {
  if (curatedToolNames.has(operation.toolName)) {
    continue;
  }

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

function normalizeTrackUris(values?: string[]): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeTrackIdsToUris(values?: string[]): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      value.startsWith("spotify:") ? value : `spotify:track:${value}`,
    );
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function getString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string.`);
  }

  return value;
}

function summarizePlaylist(playlist: Record<string, unknown>): Record<string, unknown> {
  const owner =
    typeof playlist.owner === "object" && playlist.owner !== null
      ? (playlist.owner as Record<string, unknown>)
      : undefined;
  const tracks =
    typeof playlist.tracks === "object" && playlist.tracks !== null
      ? (playlist.tracks as Record<string, unknown>)
      : undefined;

  return {
    id: playlist.id ?? null,
    uri: playlist.uri ?? null,
    name: playlist.name ?? null,
    description: playlist.description ?? null,
    public: playlist.public ?? null,
    collaborative: playlist.collaborative ?? null,
    owner: owner
      ? {
          id: owner.id ?? null,
          displayName: owner.display_name ?? null,
        }
      : null,
    tracksTotal: tracks?.total ?? null,
    externalUrl:
      typeof playlist.external_urls === "object" && playlist.external_urls !== null
        ? (playlist.external_urls as Record<string, unknown>).spotify ?? null
        : null,
  };
}

function summarizeTrack(track: Record<string, unknown>): Record<string, unknown> {
  const album =
    typeof track.album === "object" && track.album !== null
      ? (track.album as Record<string, unknown>)
      : undefined;
  const artists = Array.isArray(track.artists)
    ? (track.artists as Array<Record<string, unknown>>)
    : [];

  return {
    id: track.id ?? null,
    uri: track.uri ?? null,
    name: track.name ?? null,
    artists: artists.map((artist) => ({
      id: artist.id ?? null,
      name: artist.name ?? null,
    })),
    album: album
      ? {
          id: album.id ?? null,
          name: album.name ?? null,
        }
      : null,
    externalUrl:
      typeof track.external_urls === "object" && track.external_urls !== null
        ? (track.external_urls as Record<string, unknown>).spotify ?? null
        : null,
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
