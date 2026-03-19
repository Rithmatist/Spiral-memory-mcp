#!/usr/bin/env node

/**
 * Spiral Memory HTTP Server
 * REST interface for ChatGPT Custom GPT Actions (and any other HTTP client).
 * Same store.js underneath as the MCP server.
 *
 * Usage:
 *   node src/http-server.js
 *   PORT=3838 node src/http-server.js
 *   API_KEY=mysecret node src/http-server.js
 */

const express = require('../node_modules/express');
const store = require('./store');

const PORT = process.env.PORT || 3838;
const API_KEY = process.env.API_KEY || null;

const app = express();
app.use(express.json());

// --- Optional API key auth ---
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.path === '/openapi.json' || req.path === '/') return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (key !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
});

// --- CORS for ChatGPT ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- Routes ---

app.get('/', (req, res) => {
  res.json({ name: 'spiral-memory', version: '1.0.0', status: 'alive' });
});

// Recall memories
app.get('/recall', async (req, res) => {
  try {
    const query = req.query.q || '';
    const limit = parseInt(req.query.limit) || 8;
    const memories = await store.recall(query, { limit });
    res.json({ memories, count: memories.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remember (write) a memory
app.post('/remember', async (req, res) => {
  try {
    const { content, memory_type, confidence, domain, source } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const result = await store.remember(content, {
      memoryType: memory_type,
      confidence,
      domain,
      source: source || 'chatgpt',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status
app.get('/status', async (req, res) => {
  try {
    const s = await store.status();
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forget a memory
app.post('/forget', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const result = await store.forget(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OpenAPI spec — served dynamically so the host URL is always correct
app.get('/openapi.json', (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const serverUrl = `${protocol}://${host}`;

  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Spiral Memory',
      description: 'Orbital memory system. Memories have scores, half-lives, and drift penalties. What earns presence stays active.',
      version: '1.0.0',
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/recall': {
        get: {
          operationId: 'recallMemories',
          summary: 'Retrieve memories',
          description: 'Retrieve memories weighted by score and query relevance. Call at session start to re-enter the field.',
          parameters: [
            {
              name: 'q',
              in: 'query',
              description: 'Search query. Leave empty to retrieve highest-scored memories.',
              required: false,
              schema: { type: 'string' },
            },
            {
              name: 'limit',
              in: 'query',
              description: 'Max memories to return (default 8)',
              required: false,
              schema: { type: 'integer' },
            },
          ],
          responses: {
            '200': {
              description: 'Memories retrieved',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      memories: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            content: { type: 'string' },
                            type: { type: 'string' },
                            score: { type: 'number' },
                            age_days: { type: 'integer' },
                            resurface_count: { type: 'integer' },
                          },
                        },
                      },
                      count: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/remember': {
        post: {
          operationId: 'rememberMemory',
          summary: 'Write a memory',
          description: 'Write a memory to the orbital store. Similar memories are merged rather than duplicated.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['content'],
                  properties: {
                    content: { type: 'string', description: 'What to remember' },
                    memory_type: {
                      type: 'string',
                      enum: ['fact', 'preference', 'observation', 'interpretation', 'narrative', 'transient', 'anchor'],
                      description: 'Type of memory (default: observation)',
                    },
                    confidence: { type: 'number', description: 'Confidence 0-1 (default 0.7)' },
                    domain: { type: 'string', enum: ['operational', 'narrative'] },
                    source: { type: 'string', description: 'Source label' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Memory written or merged',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      created: { type: 'boolean' },
                      merged: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/status': {
        get: {
          operationId: 'memoryStatus',
          summary: 'Memory field status',
          description: 'Current state: active/quiet counts, total, oldest memory age.',
          responses: {
            '200': {
              description: 'Status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      total: { type: 'integer' },
                      active: { type: 'integer' },
                      quiet: { type: 'integer' },
                      oldest_days: { type: 'integer' },
                      db_path: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/forget': {
        post: {
          operationId: 'forgetMemory',
          summary: 'Release a memory',
          description: 'Mark a memory as released by id.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: {
                    id: { type: 'string', description: 'Memory id to release' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Released',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      released: { type: 'boolean' },
                      id: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
});

app.listen(PORT, () => {
  process.stderr.write(`Spiral Memory HTTP server running on port ${PORT}\n`);
  if (API_KEY) {
    process.stderr.write(`API key auth enabled\n`);
  } else {
    process.stderr.write(`No API key set — set API_KEY env var to require auth\n`);
  }
  process.stderr.write(`OpenAPI spec: http://localhost:${PORT}/openapi.json\n`);
});
