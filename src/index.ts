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
const curatedToolNames = new Set([
  "spotify.create-playlist",
  "spotify.get-artist",
  "spotify.get-album",
  "spotify.get-track",
  "spotify.get-show",
  "spotify.get-episode",
  "spotify.get-audiobook",
  "spotify.get-categories",
  "spotify.get-featured-playlists",
  "spotify.get-new-releases",
  "spotify.follow-playlist",
  "spotify.unfollow-playlist",
  "spotify.get-queue",
  "spotify.add-to-queue",
]);
const generatedOperations = operations.filter(
  (operation) => !curatedToolNames.has(operation.toolName),
);
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

server.registerTool(
  "spotify.play",
  {
    description:
      "Start or resume playback, optionally targeting a specific device, context, or set of tracks.",
    inputSchema: z.object({
      deviceId: z.string().optional(),
      contextUri: z.string().optional(),
      trackUris: z.array(z.string()).optional(),
      trackIds: z.array(z.string()).optional(),
      offsetPosition: z.number().int().min(0).optional(),
      offsetUri: z.string().optional(),
      positionMs: z.number().int().min(0).optional(),
    }),
  },
  async ({
    deviceId,
    contextUri,
    trackUris,
    trackIds,
    offsetPosition,
    offsetUri,
    positionMs,
  }) => {
    const uris = dedupeStrings([
      ...normalizeTrackUris(trackUris),
      ...normalizeTrackIdsToUris(trackIds),
    ]);
    const body: Record<string, unknown> = {};

    if (contextUri) {
      body.context_uri = contextUri;
    }

    if (uris.length > 0) {
      body.uris = uris;
    }

    if (offsetUri) {
      body.offset = { uri: offsetUri };
    } else if (offsetPosition !== undefined) {
      body.offset = { position: offsetPosition };
    }

    if (positionMs !== undefined) {
      body.position_ms = positionMs;
    }

    const response = await spotify.request({
      method: "PUT",
      path: "/me/player/play",
      query: {
        device_id: deviceId,
      },
      body: Object.keys(body).length > 0 ? body : undefined,
      requireUserAuth: true,
      requiredScopes: ["user-modify-playback-state"],
    });

    return asTextResult({
      action: "play",
      deviceId: deviceId ?? null,
      response: response.data,
    });
  },
);

server.registerTool(
  "spotify.pause",
  {
    description: "Pause playback on the active device or a specified device.",
    inputSchema: z.object({
      deviceId: z.string().optional(),
    }),
  },
  async ({ deviceId }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/player/pause",
        query: { device_id: deviceId },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.next",
  {
    description: "Skip to the next track on the active device or a specified device.",
    inputSchema: z.object({
      deviceId: z.string().optional(),
    }),
  },
  async ({ deviceId }) =>
    asTextResult(
      await spotify.request({
        method: "POST",
        path: "/me/player/next",
        query: { device_id: deviceId },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.previous",
  {
    description: "Skip to the previous track on the active device or a specified device.",
    inputSchema: z.object({
      deviceId: z.string().optional(),
    }),
  },
  async ({ deviceId }) =>
    asTextResult(
      await spotify.request({
        method: "POST",
        path: "/me/player/previous",
        query: { device_id: deviceId },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.get-devices",
  {
    description: "List the user's available Spotify Connect devices.",
  },
  async () => {
    const response = await spotify.request({
      method: "GET",
      path: "/me/player/devices",
      requireUserAuth: true,
      requiredScopes: ["user-read-playback-state"],
    });
    const data = response.data as Record<string, unknown>;
    const devices = Array.isArray(data.devices)
      ? (data.devices as Array<Record<string, unknown>>)
      : [];

    return asTextResult({
      devices: devices.map((device) => summarizeDevice(device)),
    });
  },
);

server.registerTool(
  "spotify.transfer-playback",
  {
    description: "Transfer playback to one or more device IDs.",
    inputSchema: z.object({
      deviceIds: z.array(z.string()).min(1).max(50),
      play: z.boolean().optional(),
    }),
  },
  async ({ deviceIds, play }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/player",
        body: {
          device_ids: deviceIds,
          play,
        },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.set-volume",
  {
    description: "Set playback volume on the active device or a specified device.",
    inputSchema: z.object({
      volumePercent: z.number().int().min(0).max(100),
      deviceId: z.string().optional(),
    }),
  },
  async ({ volumePercent, deviceId }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/player/volume",
        query: {
          volume_percent: volumePercent,
          device_id: deviceId,
        },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.seek",
  {
    description: "Seek to a position in the currently playing track.",
    inputSchema: z.object({
      positionMs: z.number().int().min(0),
      deviceId: z.string().optional(),
    }),
  },
  async ({ positionMs, deviceId }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/player/seek",
        query: {
          position_ms: positionMs,
          device_id: deviceId,
        },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.set-repeat",
  {
    description: "Set repeat mode to off, track, or context.",
    inputSchema: z.object({
      state: z.enum(["off", "track", "context"]),
      deviceId: z.string().optional(),
    }),
  },
  async ({ state, deviceId }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/player/repeat",
        query: {
          state,
          device_id: deviceId,
        },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.set-shuffle",
  {
    description: "Enable or disable shuffle mode.",
    inputSchema: z.object({
      state: z.boolean(),
      deviceId: z.string().optional(),
    }),
  },
  async ({ state, deviceId }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/player/shuffle",
        query: {
          state,
          device_id: deviceId,
        },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    ),
);

server.registerTool(
  "spotify.get-queue",
  {
    description: "Get the current queue and the currently playing item.",
  },
  async () => {
    const response = await spotify.request({
      method: "GET",
      path: "/me/player/queue",
      requireUserAuth: true,
      requiredScopes: ["user-read-currently-playing"],
    });
    const data = response.data as Record<string, unknown>;
    const queue = Array.isArray(data.queue)
      ? (data.queue as Array<Record<string, unknown>>)
      : [];
    const currentlyPlaying =
      typeof data.currently_playing === "object" && data.currently_playing !== null
        ? (data.currently_playing as Record<string, unknown>)
        : null;

    return asTextResult({
      currentlyPlaying: currentlyPlaying ? summarizePlayableItem(currentlyPlaying) : null,
      queue: queue.map((item) => summarizePlayableItem(item)),
    });
  },
);

server.registerTool(
  "spotify.add-to-queue",
  {
    description: "Add a track or episode to the end of the user's playback queue.",
    inputSchema: z.object({
      uri: z.string().optional(),
      trackId: z.string().optional(),
      deviceId: z.string().optional(),
    }),
  },
  async ({ uri, trackId, deviceId }) => {
    const resolvedUri = resolveSingleUri({
      uri,
      id: trackId,
      itemType: "track",
      label: "queue item",
    });

    return asTextResult(
      await spotify.request({
        method: "POST",
        path: "/me/player/queue",
        query: {
          uri: resolvedUri,
          device_id: deviceId,
        },
        requireUserAuth: true,
        requiredScopes: ["user-modify-playback-state"],
      }),
    );
  },
);

server.registerTool(
  "spotify.now-playing",
  {
    description: "Get the user's currently playing item and playback context.",
    inputSchema: z.object({
      market: z.string().optional(),
      additionalTypes: z.array(z.enum(["track", "episode"])).optional(),
    }),
  },
  async ({ market, additionalTypes }) => {
    const response = await spotify.request({
      method: "GET",
      path: "/me/player/currently-playing",
      query: {
        market,
        additional_types: additionalTypes,
      },
      requireUserAuth: true,
      requiredScopes: ["user-read-currently-playing"],
    });

    return asTextResult(summarizePlaybackState(response.data));
  },
);

server.registerTool(
  "spotify.recently-played",
  {
    description: "Get the user's recently played tracks.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      before: z.number().int().positive().optional(),
      after: z.number().int().positive().optional(),
    }),
  },
  async ({ limit, before, after }) => {
    const response = await spotify.request({
      method: "GET",
      path: "/me/player/recently-played",
      query: {
        limit,
        before,
        after,
      },
      requireUserAuth: true,
      requiredScopes: ["user-read-recently-played"],
    });
    const data = response.data as Record<string, unknown>;
    const items = Array.isArray(data.items)
      ? (data.items as Array<Record<string, unknown>>)
      : [];

    return asTextResult({
      cursors: data.cursors ?? null,
      items: items.map((item) => summarizePlayHistoryItem(item)),
    });
  },
);

server.registerTool(
  "spotify.search-tracks",
  {
    description: "Search Spotify tracks with a compact summary response.",
    inputSchema: z.object({
      query: z.string().min(1),
      market: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ query, market, limit, offset, summaryOnly }) =>
    asTextResult(
      await performSearch({
        type: "track",
        query,
        market,
        limit,
        offset,
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.search-artists",
  {
    description: "Search Spotify artists with a compact summary response.",
    inputSchema: z.object({
      query: z.string().min(1),
      market: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ query, market, limit, offset, summaryOnly }) =>
    asTextResult(
      await performSearch({
        type: "artist",
        query,
        market,
        limit,
        offset,
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.search-albums",
  {
    description: "Search Spotify albums with a compact summary response.",
    inputSchema: z.object({
      query: z.string().min(1),
      market: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ query, market, limit, offset, summaryOnly }) =>
    asTextResult(
      await performSearch({
        type: "album",
        query,
        market,
        limit,
        offset,
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.search-playlists",
  {
    description: "Search Spotify playlists with a compact summary response.",
    inputSchema: z.object({
      query: z.string().min(1),
      market: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ query, market, limit, offset, summaryOnly }) =>
    asTextResult(
      await performSearch({
        type: "playlist",
        query,
        market,
        limit,
        offset,
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.recommend-tracks",
  {
    description:
      "Get track recommendations from seed tracks, artists, and genres, with optional playlist insertion.",
    inputSchema: z.object({
      seedTrackIds: z.array(z.string()).max(5).optional(),
      seedArtistIds: z.array(z.string()).max(5).optional(),
      seedGenres: z.array(z.string()).max(5).optional(),
      market: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      addToPlaylistId: z.string().optional(),
      position: z.number().int().min(0).optional(),
    }),
  },
  async ({
    seedTrackIds,
    seedArtistIds,
    seedGenres,
    market,
    limit,
    addToPlaylistId,
    position,
  }) => {
    const query = {
      seed_tracks: joinCsv(seedTrackIds),
      seed_artists: joinCsv(seedArtistIds),
      seed_genres: joinCsv(seedGenres),
      market,
      limit,
    };

    if (!query.seed_tracks && !query.seed_artists && !query.seed_genres) {
      throw new Error("Provide at least one seed track, artist, or genre.");
    }

    const response = await spotify.request({
      method: "GET",
      path: "/recommendations",
      query,
    });
    const data = response.data as Record<string, unknown>;
    const tracks = Array.isArray(data.tracks)
      ? (data.tracks as Array<Record<string, unknown>>)
      : [];
    const uris = tracks
      .map((track) => getOptionalString(track.uri))
      .filter((value): value is string => Boolean(value));
    let addResponse: Record<string, unknown> | null = null;

    if (addToPlaylistId && uris.length > 0) {
      addResponse = await spotify.request({
        method: "POST",
        path: `/playlists/${encodeURIComponent(addToPlaylistId)}/tracks`,
        body: {
          uris,
          position,
        },
        requireUserAuth: true,
        requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
      });
    }

    return asTextResult({
      seeds: {
        trackIds: seedTrackIds ?? [],
        artistIds: seedArtistIds ?? [],
        genres: seedGenres ?? [],
      },
      tracks: tracks.map((track) => summarizeTrack(track)),
      addedToPlaylist: addToPlaylistId ?? null,
      addResult: addResponse?.data ?? null,
    });
  },
);

server.registerTool(
  "spotify.save-to-library",
  {
    description: "Save supported Spotify items to the current user's library.",
    inputSchema: z.object({
      uris: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
      itemType: z.enum(["track", "album", "episode", "show", "audiobook", "user", "playlist"]).optional(),
    }),
  },
  async ({ uris, ids, itemType }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/library",
        query: {
          uris: buildUriList({ uris, ids, itemType, label: "library items" }),
        },
        requireUserAuth: true,
        requiredScopes: [
          "user-library-modify",
          "user-follow-modify",
          "playlist-modify-public",
        ],
      }),
    ),
);

server.registerTool(
  "spotify.remove-from-library",
  {
    description: "Remove supported Spotify items from the current user's library.",
    inputSchema: z.object({
      uris: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
      itemType: z.enum(["track", "album", "episode", "show", "audiobook", "user", "playlist"]).optional(),
    }),
  },
  async ({ uris, ids, itemType }) =>
    asTextResult(
      await spotify.request({
        method: "DELETE",
        path: "/me/library",
        query: {
          uris: buildUriList({ uris, ids, itemType, label: "library items" }),
        },
        requireUserAuth: true,
        requiredScopes: [
          "user-library-modify",
          "user-follow-modify",
          "playlist-modify-public",
        ],
      }),
    ),
);

server.registerTool(
  "spotify.check-library",
  {
    description: "Check whether supported Spotify items are saved in the current user's library.",
    inputSchema: z.object({
      uris: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
      itemType: z.enum(["track", "album", "episode", "show", "audiobook", "artist", "user", "playlist"]).optional(),
    }),
  },
  async ({ uris, ids, itemType }) => {
    const resolvedUris = buildUris({ uris, ids, itemType, label: "library items" });
    const response = await spotify.request({
      method: "GET",
      path: "/me/library/contains",
      query: {
        uris: resolvedUris,
      },
      requireUserAuth: true,
      requiredScopes: ["user-library-read", "user-follow-read", "playlist-read-private"],
    });
    const data = Array.isArray(response.data) ? response.data : [];

    return asTextResult({
      items: resolvedUris.map((uri, index) => ({
        uri,
        saved: Boolean(data[index]),
      })),
    });
  },
);

server.registerTool(
  "spotify.get-liked-tracks",
  {
    description: "Get the current user's saved tracks.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ limit, offset, market, summaryOnly }) =>
    asTextResult(
      await getSavedCollection({
        path: "/me/tracks",
        query: { limit, offset, market },
        scope: "user-library-read",
        summaryOnly,
        itemSelector: (item) =>
          typeof item.track === "object" && item.track !== null
            ? summarizeTrack(item.track as Record<string, unknown>)
            : item,
      }),
    ),
);

server.registerTool(
  "spotify.get-saved-albums",
  {
    description: "Get the current user's saved albums.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ limit, offset, market, summaryOnly }) =>
    asTextResult(
      await getSavedCollection({
        path: "/me/albums",
        query: { limit, offset, market },
        scope: "user-library-read",
        summaryOnly,
        itemSelector: (item) =>
          typeof item.album === "object" && item.album !== null
            ? summarizeAlbum(item.album as Record<string, unknown>)
            : item,
      }),
    ),
);

server.registerTool(
  "spotify.get-saved-shows",
  {
    description: "Get the current user's saved shows.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ limit, offset, summaryOnly }) =>
    asTextResult(
      await getSavedCollection({
        path: "/me/shows",
        query: { limit, offset },
        scope: "user-library-read",
        summaryOnly,
        itemSelector: (item) =>
          typeof item.show === "object" && item.show !== null
            ? summarizeShow(item.show as Record<string, unknown>)
            : item,
      }),
    ),
);

server.registerTool(
  "spotify.get-saved-audiobooks",
  {
    description: "Get the current user's saved audiobooks.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ limit, offset, summaryOnly }) =>
    asTextResult(
      await getSavedCollection({
        path: "/me/audiobooks",
        query: { limit, offset },
        scope: "user-library-read",
        summaryOnly,
        itemSelector: (item) => summarizeAudiobook(item),
      }),
    ),
);

server.registerTool(
  "spotify.follow-artist",
  {
    description: "Follow one or more artists.",
    inputSchema: z.object({
      artistIds: z.array(z.string()).min(1).max(50),
    }),
  },
  async ({ artistIds }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: "/me/following",
        query: {
          type: "artist",
          ids: artistIds,
        },
        requireUserAuth: true,
        requiredScopes: ["user-follow-modify"],
      }),
    ),
);

server.registerTool(
  "spotify.unfollow-artist",
  {
    description: "Unfollow one or more artists.",
    inputSchema: z.object({
      artistIds: z.array(z.string()).min(1).max(50),
    }),
  },
  async ({ artistIds }) =>
    asTextResult(
      await spotify.request({
        method: "DELETE",
        path: "/me/following",
        query: {
          type: "artist",
          ids: artistIds,
        },
        requireUserAuth: true,
        requiredScopes: ["user-follow-modify"],
      }),
    ),
);

server.registerTool(
  "spotify.get-followed-artists",
  {
    description: "Get the current user's followed artists.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      after: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ limit, after, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: "/me/following",
      query: {
        type: "artist",
        limit,
        after,
      },
      requireUserAuth: true,
      requiredScopes: ["user-follow-read"],
    });
    const data = response.data as Record<string, unknown>;
    const artistsContainer =
      typeof data.artists === "object" && data.artists !== null
        ? (data.artists as Record<string, unknown>)
        : {};
    const items = Array.isArray(artistsContainer.items)
      ? (artistsContainer.items as Array<Record<string, unknown>>)
      : [];

    return asTextResult(
      summaryOnly ?? true
        ? {
            total: artistsContainer.total ?? items.length,
            cursors: artistsContainer.cursors ?? null,
            items: items.map((artist) => summarizeArtist(artist)),
          }
        : data,
    );
  },
);

server.registerTool(
  "spotify.follow-playlist",
  {
    description: "Follow a playlist, optionally keeping it private.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
      public: z.boolean().optional(),
    }),
  },
  async ({ playlistId, public: isPublic }) =>
    asTextResult(
      await spotify.request({
        method: "PUT",
        path: `/playlists/${encodeURIComponent(playlistId)}/followers`,
        body: {
          public: isPublic,
        },
        requireUserAuth: true,
        requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
      }),
    ),
);

server.registerTool(
  "spotify.unfollow-playlist",
  {
    description: "Unfollow a playlist.",
    inputSchema: z.object({
      playlistId: z.string().min(1),
    }),
  },
  async ({ playlistId }) =>
    asTextResult(
      await spotify.request({
        method: "DELETE",
        path: `/playlists/${encodeURIComponent(playlistId)}/followers`,
        requireUserAuth: true,
        requiredScopes: ["playlist-modify-public", "playlist-modify-private"],
      }),
    ),
);

server.registerTool(
  "spotify.get-me",
  {
    description: "Get the current user's Spotify profile.",
  },
  async () => {
    const response = await spotify.request({
      method: "GET",
      path: "/me",
      requireUserAuth: true,
      requiredScopes: ["user-read-private"],
    });

    return asTextResult(summarizeUser(response.data as Record<string, unknown>));
  },
);

server.registerTool(
  "spotify.get-top-tracks",
  {
    description: "Get the current user's top tracks.",
    inputSchema: z.object({
      timeRange: z.enum(["short_term", "medium_term", "long_term"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ timeRange, limit, offset, summaryOnly }) =>
    asTextResult(
      await getTopItems({
        type: "tracks",
        timeRange,
        limit,
        offset,
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.get-top-artists",
  {
    description: "Get the current user's top artists.",
    inputSchema: z.object({
      timeRange: z.enum(["short_term", "medium_term", "long_term"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ timeRange, limit, offset, summaryOnly }) =>
    asTextResult(
      await getTopItems({
        type: "artists",
        timeRange,
        limit,
        offset,
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.get-featured-playlists",
  {
    description: "Get Spotify's featured playlists.",
    inputSchema: z.object({
      locale: z.string().optional(),
      country: z.string().optional(),
      timestamp: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ locale, country, timestamp, limit, offset, summaryOnly }) =>
    asTextResult(
      await getPlaylistBrowseCollection({
        path: "/browse/featured-playlists",
        query: { locale, country, timestamp, limit, offset },
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.get-new-releases",
  {
    description: "Get Spotify's new album releases.",
    inputSchema: z.object({
      country: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ country, limit, offset, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: "/browse/new-releases",
      query: { country, limit, offset },
    });
    const data = response.data as Record<string, unknown>;
    const albumsContainer =
      typeof data.albums === "object" && data.albums !== null
        ? (data.albums as Record<string, unknown>)
        : {};
    const items = Array.isArray(albumsContainer.items)
      ? (albumsContainer.items as Array<Record<string, unknown>>)
      : [];

    return asTextResult(
      summaryOnly ?? true
        ? {
            total: albumsContainer.total ?? items.length,
            limit: albumsContainer.limit ?? limit ?? 20,
            offset: albumsContainer.offset ?? offset ?? 0,
            items: items.map((album) => summarizeAlbum(album)),
          }
        : data,
    );
  },
);

server.registerTool(
  "spotify.get-category-playlists",
  {
    description: "Get playlists for a Spotify browse category.",
    inputSchema: z.object({
      categoryId: z.string().min(1),
      country: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ categoryId, country, limit, offset, summaryOnly }) =>
    asTextResult(
      await getPlaylistBrowseCollection({
        path: `/browse/categories/${encodeURIComponent(categoryId)}/playlists`,
        query: { country, limit, offset },
        summaryOnly,
      }),
    ),
);

server.registerTool(
  "spotify.get-categories",
  {
    description: "Get Spotify browse categories.",
    inputSchema: z.object({
      locale: z.string().optional(),
      country: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ locale, country, limit, offset, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: "/browse/categories",
      query: { locale, country, limit, offset },
    });
    const data = response.data as Record<string, unknown>;
    const categoriesContainer =
      typeof data.categories === "object" && data.categories !== null
        ? (data.categories as Record<string, unknown>)
        : {};
    const items = Array.isArray(categoriesContainer.items)
      ? (categoriesContainer.items as Array<Record<string, unknown>>)
      : [];

    return asTextResult(
      summaryOnly ?? true
        ? {
            total: categoriesContainer.total ?? items.length,
            limit: categoriesContainer.limit ?? limit ?? 20,
            offset: categoriesContainer.offset ?? offset ?? 0,
            items: items.map((category) => summarizeCategory(category)),
          }
        : data,
    );
  },
);

server.registerTool(
  "spotify.get-artist",
  {
    description: "Get a Spotify artist by ID.",
    inputSchema: z.object({
      artistId: z.string().min(1),
    }),
  },
  async ({ artistId }) =>
    asTextResult(
      summarizeArtist(
        (await spotify.request({
          method: "GET",
          path: `/artists/${encodeURIComponent(artistId)}`,
        })).data as Record<string, unknown>,
      ),
    ),
);

server.registerTool(
  "spotify.get-artist-top-tracks",
  {
    description: "Get top tracks for a Spotify artist.",
    inputSchema: z.object({
      artistId: z.string().min(1),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ artistId, market, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: `/artists/${encodeURIComponent(artistId)}/top-tracks`,
      query: { market },
    });
    const data = response.data as Record<string, unknown>;
    const tracks = Array.isArray(data.tracks)
      ? (data.tracks as Array<Record<string, unknown>>)
      : [];

    return asTextResult(
      summaryOnly ?? true ? tracks.map((track) => summarizeTrack(track)) : data,
    );
  },
);

server.registerTool(
  "spotify.get-related-artists",
  {
    description: "Get artists related to a Spotify artist.",
    inputSchema: z.object({
      artistId: z.string().min(1),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ artistId, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: `/artists/${encodeURIComponent(artistId)}/related-artists`,
    });
    const data = response.data as Record<string, unknown>;
    const artists = Array.isArray(data.artists)
      ? (data.artists as Array<Record<string, unknown>>)
      : [];

    return asTextResult(
      summaryOnly ?? true ? artists.map((artist) => summarizeArtist(artist)) : data,
    );
  },
);

server.registerTool(
  "spotify.get-album",
  {
    description: "Get a Spotify album by ID.",
    inputSchema: z.object({
      albumId: z.string().min(1),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ albumId, market, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: `/albums/${encodeURIComponent(albumId)}`,
      query: { market },
    });

    return asTextResult(
      summaryOnly ?? true
        ? summarizeAlbum(response.data as Record<string, unknown>)
        : response.data,
    );
  },
);

server.registerTool(
  "spotify.get-track",
  {
    description: "Get a Spotify track by ID.",
    inputSchema: z.object({
      trackId: z.string().min(1),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ trackId, market, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: `/tracks/${encodeURIComponent(trackId)}`,
      query: { market },
    });

    return asTextResult(
      summaryOnly ?? true
        ? summarizeTrack(response.data as Record<string, unknown>)
        : response.data,
    );
  },
);

server.registerTool(
  "spotify.get-show",
  {
    description: "Get a Spotify show by ID.",
    inputSchema: z.object({
      showId: z.string().min(1),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ showId, market, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: `/shows/${encodeURIComponent(showId)}`,
      query: { market },
    });

    return asTextResult(
      summaryOnly ?? true
        ? summarizeShow(response.data as Record<string, unknown>)
        : response.data,
    );
  },
);

server.registerTool(
  "spotify.get-episode",
  {
    description: "Get a Spotify episode by ID.",
    inputSchema: z.object({
      episodeId: z.string().min(1),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ episodeId, market, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: `/episodes/${encodeURIComponent(episodeId)}`,
      query: { market },
    });

    return asTextResult(
      summaryOnly ?? true
        ? summarizeEpisode(response.data as Record<string, unknown>)
        : response.data,
    );
  },
);

server.registerTool(
  "spotify.get-audiobook",
  {
    description: "Get a Spotify audiobook by ID.",
    inputSchema: z.object({
      audiobookId: z.string().min(1),
      market: z.string().optional(),
      summaryOnly: z.boolean().optional(),
    }),
  },
  async ({ audiobookId, market, summaryOnly }) => {
    const response = await spotify.request({
      method: "GET",
      path: `/audiobooks/${encodeURIComponent(audiobookId)}`,
      query: { market },
    });

    return asTextResult(
      summaryOnly ?? true
        ? summarizeAudiobook(response.data as Record<string, unknown>)
        : response.data,
    );
  },
);

for (const operation of generatedOperations) {
  registerGeneratedOperation(operation);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `spotify-mcp connected over stdio with ${operations.length} schema operations plus curated helpers.`,
  );
}

function registerGeneratedOperation(operation: OperationDefinition): void {
  if (curatedToolNames.has(operation.toolName)) {
    return;
  }

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

async function performSearch(input: {
  type: "track" | "artist" | "album" | "playlist";
  query: string;
  market?: string;
  limit?: number;
  offset?: number;
  summaryOnly?: boolean;
}): Promise<Record<string, unknown>> {
  const response = await spotify.request({
    method: "GET",
    path: "/search",
    query: {
      q: input.query,
      type: [input.type],
      market: input.market,
      limit: input.limit,
      offset: input.offset,
    },
  });
  const data = response.data as Record<string, unknown>;
  const containerName = `${input.type}s`;
  const container =
    typeof data[containerName] === "object" && data[containerName] !== null
      ? (data[containerName] as Record<string, unknown>)
      : {};
  const items = Array.isArray(container.items)
    ? (container.items as Array<Record<string, unknown>>)
    : [];

  return input.summaryOnly ?? true
    ? {
        total: container.total ?? items.length,
        limit: container.limit ?? input.limit ?? 10,
        offset: container.offset ?? input.offset ?? 0,
        items: items.map((item) => summarizeSearchItem(input.type, item)),
      }
    : data;
}

async function getSavedCollection(input: {
  path: string;
  query: Record<string, unknown>;
  scope: string;
  summaryOnly?: boolean;
  itemSelector: (item: Record<string, unknown>) => unknown;
}): Promise<Record<string, unknown>> {
  const response = await spotify.request({
    method: "GET",
    path: input.path,
    query: input.query,
    requireUserAuth: true,
    requiredScopes: [input.scope],
  });
  const data = response.data as Record<string, unknown>;
  const items = Array.isArray(data.items)
    ? (data.items as Array<Record<string, unknown>>)
    : [];

  return input.summaryOnly ?? true
    ? {
        total: data.total ?? items.length,
        limit: data.limit ?? input.query.limit ?? items.length,
        offset: data.offset ?? input.query.offset ?? 0,
        items: items.map((item) => input.itemSelector(item)),
      }
    : data;
}

async function getTopItems(input: {
  type: "tracks" | "artists";
  timeRange?: "short_term" | "medium_term" | "long_term";
  limit?: number;
  offset?: number;
  summaryOnly?: boolean;
}): Promise<Record<string, unknown>> {
  const response = await spotify.request({
    method: "GET",
    path: `/me/top/${input.type}`,
    query: {
      time_range: input.timeRange,
      limit: input.limit,
      offset: input.offset,
    },
    requireUserAuth: true,
    requiredScopes: ["user-top-read"],
  });
  const data = response.data as Record<string, unknown>;
  const items = Array.isArray(data.items)
    ? (data.items as Array<Record<string, unknown>>)
    : [];

  return input.summaryOnly ?? true
    ? {
        total: data.total ?? items.length,
        limit: data.limit ?? input.limit ?? items.length,
        offset: data.offset ?? input.offset ?? 0,
        items: items.map((item) =>
          input.type === "tracks" ? summarizeTrack(item) : summarizeArtist(item),
        ),
      }
    : data;
}

async function getPlaylistBrowseCollection(input: {
  path: string;
  query: Record<string, unknown>;
  summaryOnly?: boolean;
}): Promise<Record<string, unknown>> {
  const response = await spotify.request({
    method: "GET",
    path: input.path,
    query: input.query,
  });
  const data = response.data as Record<string, unknown>;
  const playlists =
    typeof data.playlists === "object" && data.playlists !== null
      ? (data.playlists as Record<string, unknown>)
      : {};
  const items = Array.isArray(playlists.items)
    ? (playlists.items as Array<Record<string, unknown>>)
    : [];

  return input.summaryOnly ?? true
    ? {
        message:
          typeof data.message === "string" ? data.message : null,
        total: playlists.total ?? items.length,
        limit: playlists.limit ?? input.query.limit ?? items.length,
        offset: playlists.offset ?? input.query.offset ?? 0,
        items: items.map((playlist) => summarizePlaylist(playlist)),
      }
    : data;
}

function buildUris(input: {
  uris?: string[];
  ids?: string[];
  itemType?: string;
  label: string;
}): string[] {
  const directUris = dedupeStrings(input.uris ?? []);
  const ids = dedupeStrings(input.ids ?? []);

  if (ids.length > 0 && !input.itemType) {
    throw new Error(`itemType is required when ${input.label} are provided as IDs.`);
  }

  return dedupeStrings([
    ...directUris,
    ...ids.map((id) => `spotify:${input.itemType}:${id}`),
  ]);
}

function buildUriList(input: {
  uris?: string[];
  ids?: string[];
  itemType?: string;
  label: string;
}): string[] {
  const uris = buildUris(input);

  if (uris.length === 0) {
    throw new Error(`Provide at least one ${input.label} URI or ID.`);
  }

  return uris;
}

function resolveSingleUri(input: {
  uri?: string;
  id?: string;
  itemType: string;
  label: string;
}): string {
  const uris = buildUriList({
    uris: input.uri ? [input.uri] : [],
    ids: input.id ? [input.id] : [],
    itemType: input.itemType,
    label: input.label,
  });

  if (uris.length !== 1) {
    throw new Error(`Provide exactly one ${input.label} URI or ID.`);
  }

  return uris[0];
}

function joinCsv(values?: string[]): string | undefined {
  const items = dedupeStrings(values ?? []);
  return items.length > 0 ? items.join(",") : undefined;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function summarizeSearchItem(
  type: "track" | "artist" | "album" | "playlist",
  item: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "track":
      return summarizeTrack(item);
    case "artist":
      return summarizeArtist(item);
    case "album":
      return summarizeAlbum(item);
    case "playlist":
      return summarizePlaylist(item);
  }
}

function summarizePlayableItem(item: Record<string, unknown>): Record<string, unknown> {
  const type = getOptionalString(item.type);

  if (type === "episode") {
    return summarizeEpisode(item);
  }

  return summarizeTrack(item);
}

function summarizePlaybackState(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    return { state: payload };
  }

  const state = payload as Record<string, unknown>;
  const item =
    typeof state.item === "object" && state.item !== null
      ? (state.item as Record<string, unknown>)
      : null;
  const device =
    typeof state.device === "object" && state.device !== null
      ? (state.device as Record<string, unknown>)
      : null;
  const context =
    typeof state.context === "object" && state.context !== null
      ? (state.context as Record<string, unknown>)
      : null;

  return {
    isPlaying: state.is_playing ?? null,
    progressMs: state.progress_ms ?? null,
    repeatState: state.repeat_state ?? null,
    shuffleState: state.shuffle_state ?? null,
    device: device ? summarizeDevice(device) : null,
    context: context
      ? {
          type: context.type ?? null,
          uri: context.uri ?? null,
        }
      : null,
    item: item ? summarizePlayableItem(item) : null,
  };
}

function summarizePlayHistoryItem(item: Record<string, unknown>): Record<string, unknown> {
  const track =
    typeof item.track === "object" && item.track !== null
      ? (item.track as Record<string, unknown>)
      : null;

  return {
    playedAt: item.played_at ?? null,
    context: item.context ?? null,
    track: track ? summarizePlayableItem(track) : null,
  };
}

function summarizeArtist(artist: Record<string, unknown>): Record<string, unknown> {
  const followers =
    typeof artist.followers === "object" && artist.followers !== null
      ? (artist.followers as Record<string, unknown>)
      : undefined;

  return {
    id: artist.id ?? null,
    uri: artist.uri ?? null,
    name: artist.name ?? null,
    genres: artist.genres ?? [],
    popularity: artist.popularity ?? null,
    followers: followers?.total ?? null,
    externalUrl: extractSpotifyUrl(artist.external_urls),
  };
}

function summarizeAlbum(album: Record<string, unknown>): Record<string, unknown> {
  const artists = Array.isArray(album.artists)
    ? (album.artists as Array<Record<string, unknown>>)
    : [];

  return {
    id: album.id ?? null,
    uri: album.uri ?? null,
    name: album.name ?? null,
    albumType: album.album_type ?? null,
    releaseDate: album.release_date ?? null,
    totalTracks: album.total_tracks ?? null,
    artists: artists.map((artist) => ({
      id: artist.id ?? null,
      name: artist.name ?? null,
    })),
    externalUrl: extractSpotifyUrl(album.external_urls),
  };
}

function summarizeShow(show: Record<string, unknown>): Record<string, unknown> {
  return {
    id: show.id ?? null,
    uri: show.uri ?? null,
    name: show.name ?? null,
    publisher: show.publisher ?? null,
    description: show.description ?? null,
    totalEpisodes: show.total_episodes ?? null,
    mediaType: show.media_type ?? null,
    externalUrl: extractSpotifyUrl(show.external_urls),
  };
}

function summarizeEpisode(episode: Record<string, unknown>): Record<string, unknown> {
  const show =
    typeof episode.show === "object" && episode.show !== null
      ? (episode.show as Record<string, unknown>)
      : undefined;

  return {
    id: episode.id ?? null,
    uri: episode.uri ?? null,
    name: episode.name ?? null,
    description: episode.description ?? null,
    releaseDate: episode.release_date ?? null,
    durationMs: episode.duration_ms ?? null,
    explicit: episode.explicit ?? null,
    show: show
      ? {
          id: show.id ?? null,
          name: show.name ?? null,
        }
      : null,
    externalUrl: extractSpotifyUrl(episode.external_urls),
  };
}

function summarizeAudiobook(audiobook: Record<string, unknown>): Record<string, unknown> {
  const authors = Array.isArray(audiobook.authors)
    ? (audiobook.authors as Array<Record<string, unknown>>)
    : [];

  return {
    id: audiobook.id ?? null,
    uri: audiobook.uri ?? null,
    name: audiobook.name ?? null,
    description: audiobook.description ?? null,
    edition: audiobook.edition ?? null,
    totalChapters: audiobook.total_chapters ?? null,
    authors: authors.map((author) => author.name ?? null),
    externalUrl: extractSpotifyUrl(audiobook.external_urls),
  };
}

function summarizeCategory(category: Record<string, unknown>): Record<string, unknown> {
  return {
    id: category.id ?? null,
    name: category.name ?? null,
    href: category.href ?? null,
  };
}

function summarizeDevice(device: Record<string, unknown>): Record<string, unknown> {
  return {
    id: device.id ?? null,
    name: device.name ?? null,
    type: device.type ?? null,
    isActive: device.is_active ?? null,
    isRestricted: device.is_restricted ?? null,
    volumePercent: device.volume_percent ?? null,
    supportsVolume: device.supports_volume ?? null,
  };
}

function summarizeUser(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: user.id ?? null,
    uri: user.uri ?? null,
    displayName: user.display_name ?? null,
    country: user.country ?? null,
    product: user.product ?? null,
    email: user.email ?? null,
    followers:
      typeof user.followers === "object" && user.followers !== null
        ? (user.followers as Record<string, unknown>).total ?? null
        : null,
    externalUrl: extractSpotifyUrl(user.external_urls),
  };
}

function extractSpotifyUrl(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>).spotify ?? null
    : null;
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
