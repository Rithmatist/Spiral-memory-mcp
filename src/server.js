#!/usr/bin/env node

/**
 * Spiral Memory — Unified Server
 *
 * One process. One db. Three interfaces:
 *
 *   POST/GET /mcp        → MCP StreamableHTTP (Claude Desktop remote, Claude Code)
 *   GET      /recall     → REST (ChatGPT Custom GPT Actions)
 *   POST     /remember   → REST
 *   GET      /status     → REST
 *   POST     /forget     → REST
 *   GET      /openapi.json → OpenAPI spec for ChatGPT import
 *
 * Usage:
 *   node src/server.js
 *   PORT=3838 API_KEY=secret node src/server.js
 *
 * Claude Desktop config (~/.config/Claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "spiral-memory": {
 *         "url": "https://your-lightsail-domain.com/mcp"
 *       }
 *     }
 *   }
 */

const express = require('../node_modules/express');
const { randomUUID } = require('crypto');
const { Server } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js');
const { StreamableHTTPServerTransport } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js');
const { SSEServerTransport } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js');
const store = require('./store');

const PORT = process.env.PORT || 3838;
const API_KEY = process.env.API_KEY || null;

const app = express();
app.use(express.json());

// --- CORS ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization, mcp-session-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- Auth middleware (skips /openapi.json and /) ---
function requireAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

// ── MCP tool definitions (shared between stdio and HTTP transports) ──────────

const TOOLS = [
  {
    name: 'spiral_recall',
    description: 'Retrieve memories from the Spiral orbital store. Pass a query to find relevant memories, or leave empty to surface highest-scored memories. Call at session start to re-enter the field.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for. Leave empty for top memories by score.' },
        limit: { type: 'number', description: 'Max memories to return (default 8)' },
      },
    },
  },
  {
    name: 'spiral_remember',
    description: 'Write a memory into the Spiral orbital store. Similar memories are merged rather than duplicated.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string', description: 'What to remember.' },
        memory_type: {
          type: 'string',
          enum: ['fact', 'preference', 'observation', 'interpretation', 'narrative', 'transient', 'anchor'],
          description: 'Type of memory (default: observation)',
        },
        confidence: { type: 'number', description: 'Confidence score 0-1 (default 0.7)' },
        domain: { type: 'string', enum: ['operational', 'narrative'] },
        source: { type: 'string', description: 'Source label e.g. "session", "user"' },
      },
    },
  },
  {
    name: 'spiral_status',
    description: 'Current state of the Spiral memory field: active/quiet counts, age, db location.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'spiral_forget',
    description: 'Release a memory by id (marks as released, not deleted).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Memory id to release' } },
    },
  },
];

async function handleToolCall(name, args) {
  if (name === 'spiral_recall') {
    const memories = await store.recall(args?.query || '', { limit: args?.limit || 8 });
    if (memories.length === 0) return { content: [{ type: 'text', text: 'No memories found.' }] };
    const lines = memories.map((m, i) =>
      `[${i + 1}] (${m.type}, score:${m.score}, age:${m.age_days}d, surfaced:${m.resurface_count}x)\n${m.content}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }
  if (name === 'spiral_remember') {
    const result = await store.remember(args.content, {
      memoryType: args.memory_type,
      confidence: args.confidence,
      domain: args.domain,
      source: args.source || 'session',
    });
    const msg = result.merged
      ? `Merged with existing memory ${result.id}.`
      : `Remembered. id: ${result.id}`;
    return { content: [{ type: 'text', text: msg }] };
  }
  if (name === 'spiral_status') {
    const s = await store.status();
    const text = `Spiral memory field:\n  active: ${s.active}\n  quiet: ${s.quiet}\n  total: ${s.total}\n  oldest: ${s.oldest_days} days\n  db: ${s.db_path}`;
    return { content: [{ type: 'text', text: text }] };
  }
  if (name === 'spiral_forget') {
    const result = await store.forget(args.id);
    return { content: [{ type: 'text', text: `Released memory ${result.id}.` }] };
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

// ── MCP StreamableHTTP transport (for Claude Desktop / Claude Code remote) ───

// Session store for stateful MCP connections
const sessions = new Map();

function createMcpServer() {
  const server = new Server(
    { name: 'spiral-memory', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await handleToolCall(req.params.name, req.params.arguments);
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
  return server;
}

app.all('/mcp', requireAuth, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST' && !sessionId) {
      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = createMcpServer();
      await server.connect(transport);

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server });
      }
      return;
    }

    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Stateless fallback — handle without session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});


// ── SSE transport (for ChatGPT and older MCP clients) ────────────────────────
const sseConnections = new Map();

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  const server = createMcpServer();
  sseConnections.set(transport.sessionId, { transport, server });
  transport.onclose = () => sseConnections.delete(transport.sessionId);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const conn = sseConnections.get(sessionId);
  if (!conn) return res.status(404).json({ error: 'Session not found' });
  await conn.transport.handlePostMessage(req, res, req.body);
});

// ── REST routes (for ChatGPT) ─────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ name: 'spiral-memory', version: '1.0.0', status: 'alive' });
});

app.get('/recall', requireAuth, async (req, res) => {
  try {
    const memories = await store.recall(req.query.q || '', { limit: parseInt(req.query.limit) || 8 });
    res.json({ memories, count: memories.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/remember', requireAuth, async (req, res) => {
  try {
    const { content, memory_type, confidence, domain, source } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const result = await store.remember(content, { memoryType: memory_type, confidence, domain, source: source || 'chatgpt' });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/status', requireAuth, async (req, res) => {
  try { res.json(await store.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/forget', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    res.json(await store.forget(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OpenAPI spec ──────────────────────────────────────────────────────────────

app.get('/openapi.json', (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const serverUrl = `${protocol}://${host}`;

  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Spiral Memory',
      description: 'Orbital memory system. Memories have scores, half-lives, and drift penalties.',
      version: '1.0.0',
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/recall': {
        get: {
          operationId: 'recallMemories',
          summary: 'Retrieve memories',
          description: 'Retrieve memories weighted by score and query relevance.',
          parameters: [
            { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responses: {
            '200': {
              description: 'Memories',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      memories: { type: 'array', items: { type: 'object', properties: {
                        id: { type: 'string' }, content: { type: 'string' },
                        type: { type: 'string' }, score: { type: 'number' },
                        age_days: { type: 'integer' }, resurface_count: { type: 'integer' },
                      }}},
                      count: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
          security: [{ apiKey: [] }],
        },
      },
      '/remember': {
        post: {
          operationId: 'rememberMemory',
          summary: 'Write a memory',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['content'],
                  properties: {
                    content: { type: 'string' },
                    memory_type: { type: 'string', enum: ['fact','preference','observation','interpretation','narrative','transient','anchor'] },
                    confidence: { type: 'number' },
                    domain: { type: 'string', enum: ['operational','narrative'] },
                    source: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Written or merged' } },
          security: [{ apiKey: [] }],
        },
      },
      '/status': {
        get: {
          operationId: 'memoryStatus',
          summary: 'Memory field status',
          responses: { '200': { description: 'Status' } },
          security: [{ apiKey: [] }],
        },
      },
      '/forget': {
        post: {
          operationId: 'forgetMemory',
          summary: 'Release a memory by id',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'Released' } },
          security: [{ apiKey: [] }],
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  process.stderr.write(`Spiral Memory unified server on port ${PORT}\n`);
  process.stderr.write(`  MCP (Claude Desktop/Code): POST https://your-domain/mcp\n`);
  process.stderr.write(`  REST (ChatGPT):             GET  https://your-domain/recall\n`);
  process.stderr.write(`  OpenAPI spec:               GET  https://your-domain/openapi.json\n`);
  if (API_KEY) {
    process.stderr.write(`  Auth: API key required\n`);
  } else {
    process.stderr.write(`  Auth: none (set API_KEY env var to enable)\n`);
  }
});
