# spiral-memory-mcp

Spiral Companion's orbital memory system. One database, three interfaces.

```
Claude Desktop / Code  →  MCP StreamableHTTP  →  /mcp
ChatGPT Custom GPT     →  REST API            →  /recall /remember /status /forget
Any HTTP client        →  OpenAPI spec        →  /openapi.json
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
# Start the unified server
API_KEY=yourkey node src/server.js

# Keep it alive across reboots with PM2
npm install -g pm2
pm2 start src/server.js --name spiral-memory
pm2 startup   # copy-paste the command it gives you
pm2 save
```

Open port 3838 in your Lightsail console:
Networking tab → Add rule → Custom TCP → port 3838

---

## Connect to ChatGPT

1. Point a domain at your Lightsail IP (or use Caddy for HTTPS — see below)
2. Go to **chatgpt.com → Explore GPTs → Create → Configure → Actions → Create new action**
3. Import schema from URL: `https://your-domain.com/openapi.json`
4. Set Authentication → API Key → Header name: `x-api-key` → your key
5. Save

ChatGPT can now call `recallMemories`, `rememberMemory`, `memoryStatus`, `forgetMemory`.

---

## Connect to Claude Desktop

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
