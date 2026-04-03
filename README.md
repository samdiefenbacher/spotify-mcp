# spotify-mcp

Spotify MCP server over stdio, with Docker support. The server loads Spotify's OpenAPI schema from `spotify-openapi.yaml` and registers MCP tools for the documented Web API operations, plus a few auth/bootstrap helpers.

## What this scaffold includes

- A stdio MCP server built on `@modelcontextprotocol/sdk`
- Generated MCP tools for the Spotify Web API operations in the bundled schema snapshot
- Curated playlist tools for common create, add, search, edit, remove, replace, and reorder workflows
- Auth helpers for localhost OAuth bootstrap, token persistence, and PKCE fallback
- A generic raw request tool for cases where you want to hit a path directly
- A Docker image that runs the same stdio server

## Requirements

- Node.js 22+
- A Spotify developer app for user auth or client credentials: <https://developer.spotify.com/dashboard>

## Environment

Set the variables you need in `.env` or your container environment:

- `SPOTIFY_CLIENT_ID`: required for public API access and user auth
- `SPOTIFY_CLIENT_SECRET`: recommended; enables client-credentials auth, localhost user auth, and token refresh
- `SPOTIFY_ACCESS_TOKEN`: optional bootstrap token
- `SPOTIFY_REFRESH_TOKEN`: optional persistent user token refresh path
- `SPOTIFY_ACCESS_TOKEN_EXPIRES_AT`: optional ISO timestamp or epoch milliseconds
- `SPOTIFY_TOKEN_SCOPES`: optional space/comma-separated scope list
- `SPOTIFY_DEFAULT_REDIRECT_URI`: optional, default `http://127.0.0.1:8888/callback`
- `SPOTIFY_TOKEN_STORE_PATH`: optional, default `.spotify-tokens.json`
- `SPOTIFY_OPENAPI_SCHEMA`: optional override for the schema file path

## Local run

```bash
npm install
npm run build
npm start
```

## Docker run

Build the image:

```bash
docker build -t spotify-mcp .
```

Run it over stdio:

```bash
docker run --rm -i --env-file .env spotify-mcp
```

The container must stay attached to stdin/stdout because MCP is using stdio transport.

## Auth bootstrap

For public, non-user-specific endpoints, `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are enough. The server will fetch and refresh app tokens automatically.

For user-scoped endpoints, authorize once and let the server store the resulting refresh token:

1. Add `http://127.0.0.1:8888/callback` or your chosen loopback callback URL to your Spotify app settings
2. Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`
3. Call `spotify.begin-user-auth`
4. Open the returned `authorizationUrl` in your browser and approve the app
5. Wait for Spotify to redirect back to the local callback URL
6. Call `spotify.await-user-auth` if you want an explicit success response

The server writes the access token, refresh token, expiry, and scopes to `.spotify-tokens.json` by default, and refreshes user tokens automatically on later runs.

If you prefer a manual fallback, `spotify.begin-pkce-auth` and `spotify.complete-pkce-auth` are still available.

## Curated tools

Playlist workflows:

- `spotify.create-playlist`
- `spotify.get-my-playlists`
- `spotify.add-tracks`
- `spotify.search-and-add`
- `spotify.update-playlist-details`
- `spotify.remove-tracks`
- `spotify.replace-tracks`
- `spotify.reorder-tracks`

Player control:

- `spotify.play`
- `spotify.pause`
- `spotify.next`
- `spotify.previous`
- `spotify.get-devices`
- `spotify.transfer-playback`
- `spotify.set-volume`
- `spotify.seek`
- `spotify.set-repeat`
- `spotify.set-shuffle`
- `spotify.get-queue`
- `spotify.add-to-queue`
- `spotify.now-playing`
- `spotify.recently-played`

Search, recommendations, and library:

- `spotify.search-tracks`
- `spotify.search-artists`
- `spotify.search-albums`
- `spotify.search-playlists`
- `spotify.recommend-tracks`
- `spotify.save-to-library`
- `spotify.remove-from-library`
- `spotify.check-library`
- `spotify.get-liked-tracks`
- `spotify.get-saved-albums`
- `spotify.get-saved-shows`
- `spotify.get-saved-audiobooks`

Profile and discovery:

- `spotify.get-me`
- `spotify.get-top-tracks`
- `spotify.get-top-artists`
- `spotify.follow-artist`
- `spotify.unfollow-artist`
- `spotify.get-followed-artists`
- `spotify.follow-playlist`
- `spotify.unfollow-playlist`
- `spotify.get-featured-playlists`
- `spotify.get-new-releases`
- `spotify.get-category-playlists`
- `spotify.get-categories`
- `spotify.get-artist`
- `spotify.get-artist-top-tracks`
- `spotify.get-related-artists`
- `spotify.get-album`
- `spotify.get-track`
- `spotify.get-show`
- `spotify.get-episode`
- `spotify.get-audiobook`

## Notes

- Many Spotify endpoints require user scopes. The generated tool descriptions include the required scopes from the OpenAPI schema when present.
- Local user auth requires a loopback redirect URI with an explicit port, such as `http://127.0.0.1:8888/callback`.
- Some Spotify capabilities are outside the Web API itself. This server only scaffolds the Web API surface described by the provided schema.
