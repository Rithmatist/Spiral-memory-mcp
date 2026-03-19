# spiral-memory-mcp

Spiral Companion's orbital memory system. One database, three interfaces.

```
Claude Desktop / Code      →  MCP StreamableHTTP  →  /mcp
ChatGPT Developer Mode     →  MCP StreamableHTTP  →  /mcp
GPT Actions / HTTP clients →  REST API            →  /recall /remember /status /forget
OpenAPI import             →  /openapi.json
```

Memories have scores, half-lives, drift penalties, and deduplication.
What earns presence through recurrence stays active. What fades goes quiet.

---

## Install

```bash
unzip spiral-memory-mcp.zip
cd spiral-memory-mcp
npm install
```

---

## Run (Lightsail / any VPS)

```bash
# Start the unified server with API key auth for REST / GPT Actions
API_KEY=yourkey node src/server.js

# Start with OAuth for remote MCP clients (ChatGPT Developer Mode / Claude)
PUBLIC_BASE_URL=https://your-domain.com \
OAUTH_ISSUER_URL=https://auth.example.com/ \
OAUTH_AUTHORIZATION_URL=https://auth.example.com/authorize \
OAUTH_TOKEN_URL=https://auth.example.com/oauth/token \
OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json \
OAUTH_AUDIENCE=https://your-domain.com/mcp \
OAUTH_SCOPES=mcp:tools \
node src/server.js

# Keep it alive across reboots with PM2
npm install -g pm2
pm2 start src/server.js --name spiral-memory
pm2 startup   # copy-paste the command it gives you
pm2 save
```

Open port 3838 in your Lightsail console:
Networking tab → Add rule → Custom TCP → port 3838

---

## OAuth for ChatGPT MCP + Claude

The unified server can now protect `/mcp` with OAuth 2.0 bearer tokens for remote MCP clients.

Required env vars:

```bash
PUBLIC_BASE_URL=https://your-domain.com
OAUTH_ISSUER_URL=https://auth.example.com/
OAUTH_AUTHORIZATION_URL=https://auth.example.com/authorize
OAUTH_TOKEN_URL=https://auth.example.com/oauth/token
OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
OAUTH_AUDIENCE=https://your-domain.com/mcp
```

Optional env vars:

```bash
OAUTH_SCOPES=mcp:tools
OAUTH_REGISTRATION_URL=https://auth.example.com/connect/register
API_KEY=yourkey
```

Notes:
- OAuth only protects `/mcp`.
- ChatGPT Developer Mode / Apps should use `/mcp` with OAuth, not the REST API key path.
- Legacy `/sse` and `/messages` are disabled when OAuth is enabled, to prevent bypassing `/mcp`.
- REST endpoints (`/recall`, `/remember`, `/status`, `/forget`) still use `API_KEY` for direct HTTP use or GPT Actions-style OpenAPI integrations.
- Current OAuth mode expects JWT access tokens signed by the issuer behind `OAUTH_JWKS_URI`.
- If your auth provider supports Dynamic Client Registration, set `OAUTH_REGISTRATION_URL`. Otherwise enter the client ID and client secret manually in ChatGPT and Claude.

### Setup checklist

#### 1. Prepare a public HTTPS URL

You need a public HTTPS base URL for this server, for example:

```text
https://memory.example.com
```

Your MCP endpoint will be:

```text
https://memory.example.com/mcp
```

#### 2. Configure your OAuth provider

Your provider needs to support:
- OAuth 2.0 Authorization Code flow with PKCE
- JWT access tokens
- A JWKS endpoint
- Refresh tokens if you want long-lived connector sessions

Recommended resource settings:
- Audience / resource: `https://memory.example.com/mcp`
- Scope: `mcp:tools`

Callback / client notes:
- Claude supports DCR, and users can also enter a custom client ID and secret if DCR is unavailable.
- Claude's documented callback URL is `https://claude.ai/api/mcp/auth_callback`.
- Anthropic also says to allowlist `https://claude.com/api/mcp/auth_callback` for future compatibility.
- ChatGPT Developer Mode supports OAuth and DCR. If static credentials are provided, ChatGPT will use them. Otherwise it can use dynamic client registration.
- If your provider does not support DCR, create an OAuth client in your provider and keep the client ID and client secret ready for ChatGPT and Claude.

Important:
- This server currently validates JWT access tokens via `OAUTH_JWKS_URI`.
- It does not implement opaque-token introspection.

#### 3. Export the server env vars

Replace the example values with your real domain and OAuth provider URLs:

```bash
PUBLIC_BASE_URL=https://memory.example.com
OAUTH_ISSUER_URL=https://auth.example.com/
OAUTH_AUTHORIZATION_URL=https://auth.example.com/authorize
OAUTH_TOKEN_URL=https://auth.example.com/oauth/token
OAUTH_JWKS_URI=https://auth.example.com/.well-known/jwks.json
OAUTH_AUDIENCE=https://memory.example.com/mcp
OAUTH_SCOPES=mcp:tools
```

If your auth server supports Dynamic Client Registration, also set:

```bash
OAUTH_REGISTRATION_URL=https://auth.example.com/connect/register
```

If you also want to keep the REST/OpenAPI path protected for direct HTTP or GPT Actions, set:

```bash
API_KEY=your-rest-api-key
```

#### 4. Start the server

```bash
node src/server.js
```

On startup, the server should log the MCP OAuth metadata URL and issuer.

#### 5. Verify the OAuth metadata endpoints

Open these URLs in a browser or with `curl`:

```text
https://memory.example.com/.well-known/oauth-protected-resource/mcp
https://memory.example.com/.well-known/oauth-authorization-server
```

Expected result:
- The protected-resource document should point at your `/mcp` URL.
- The authorization-server document should contain your issuer, authorization endpoint, token endpoint, and optional registration endpoint.

You can also test the auth challenge:

```bash
curl -i -X POST https://memory.example.com/mcp \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected result:
- `401 Unauthorized`
- `WWW-Authenticate` header containing `resource_metadata=.../oauth-protected-resource/mcp`

### ChatGPT Developer Mode / Apps

1. Enable **Developer mode** in ChatGPT.
2. Create an app for the remote MCP server URL: `https://your-domain.com/mcp`
3. Choose **OAuth** authentication.
4. If your provider does not support DCR, enter the OAuth client ID and client secret from your auth provider.
5. If your provider requires scopes, use the same values you set in `OAUTH_SCOPES`.
6. Save the app, enable the tools you want, and connect the account when ChatGPT prompts for sign-in.

This is the recommended ChatGPT path for this repo. Do not use the API key REST flow for ChatGPT MCP apps.

### Claude custom connector

1. Open **Add custom connector**.
2. Set **Remote MCP server URL** to `https://your-domain.com/mcp`
3. If DCR is unavailable, enter the OAuth client ID and client secret from the same auth provider.
4. Save and complete the OAuth consent flow.
5. Enable the tools you want Claude to use.

### Troubleshooting

- If ChatGPT or Claude cannot start auth, check that `/.well-known/oauth-protected-resource/mcp` is reachable over HTTPS.
- If login succeeds but the connector still fails, check that your access token is a JWT and that its `aud` matches `OAUTH_AUDIENCE`.
- If Claude auth fails at the redirect step, verify that `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback` are allowlisted in your OAuth provider.
- If ChatGPT does not use DCR with your provider, create a client manually and paste the client ID and secret into the ChatGPT app config.
- If you see auth success but no tools, refresh the connector/app so the client re-reads the MCP tool list.

---

## Separate OpenAPI Path: GPT Actions / Direct HTTP

This is a different integration path from ChatGPT MCP apps.

OpenAI's GPT Actions docs still list `None`, `API Key`, and `OAuth` as supported authentication modes for Actions. If you use the OpenAPI/REST path in this repo, API key auth remains valid there.

### GPT Actions with API key

1. Point a domain at your Lightsail IP (or use Caddy for HTTPS — see below)
2. Go to **chatgpt.com → Explore GPTs → Create → Configure → Actions → Create new action**
3. Import schema from URL: `https://your-domain.com/openapi.json`
4. Set Authentication → API Key → Header name: `x-api-key` → your key
5. Save

ChatGPT can now call `recallMemories`, `rememberMemory`, `memoryStatus`, `forgetMemory`.

---

## Connect to Claude Desktop (API Key)

Add to your Claude Desktop config:

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "spiral-memory": {
      "url": "https://your-domain.com/mcp",
      "headers": {
        "x-api-key": "yourkey"
      }
    }
  }
}
```

Restart Claude Desktop. The `spiral_recall`, `spiral_remember`, `spiral_status`, `spiral_forget` tools will appear.

---

## HTTPS with Caddy (required for ChatGPT)

ChatGPT requires HTTPS. Caddy handles SSL automatically with Let's Encrypt.

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Create Caddyfile (replace your-domain.com with your actual domain)
sudo tee /etc/caddy/Caddyfile << EOF
your-domain.com {
    reverse_proxy localhost:3838
}
EOF

sudo systemctl reload caddy
```

Your server is now at `https://your-domain.com` with automatic SSL.

---

## Tools (MCP)

| Tool | What it does |
|------|-------------|
| `spiral_recall` | Retrieve memories by query or top score |
| `spiral_remember` | Write a memory. Similar memories merge. |
| `spiral_status` | Active/quiet counts, age, db path |
| `spiral_forget` | Release a memory by id |

## Endpoints (REST)

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/recall?q=query&limit=8` | GET | Retrieve memories |
| `/remember` | POST | Write a memory |
| `/status` | GET | Field status |
| `/forget` | POST | Release by id |
| `/openapi.json` | GET | OpenAPI spec for ChatGPT import |
| `/mcp` | POST/GET | MCP StreamableHTTP endpoint |

---

## Memory location

Default: `~/.spiral-memory/memory.db`

Override:
```bash
SPIRAL_MEMORY_PATH=/your/path/memory.db node src/server.js
```

---

## How scoring works

Each memory scores on:
- **confidence** (0.38 weight) — how certain the memory is
- **freshness** (0.27) — recency with exponential decay by half-life
- **recurrence** (0.13) — how often it has been surfaced
- **base** (0.22) — stable floor

Memories below score 0.18 are demoted to quiet on status check.
Memories with Jaccard similarity > 0.86 are merged rather than duplicated.

## Memory types

`anchor` · `fact` · `preference` · `observation` · `interpretation` · `narrative` · `transient`

Anchors are protected from rotation — use for core context that should always surface.
