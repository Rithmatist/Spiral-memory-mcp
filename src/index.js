#!/usr/bin/env node

/**
 * Spiral Memory MCP Server
 *
 * Exposes Spiral Companion's orbital memory system as an MCP tool server.
 * Connect via Claude Desktop or any MCP-compatible client.
 *
 * Tools:
 *   spiral_recall   - retrieve memories weighted by score + query relevance
 *   spiral_remember - write a memory to the orbital store
 *   spiral_status   - current state of the memory field
 *   spiral_forget   - release a memory by id
 */

const { Server } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js');
const { StdioServerTransport } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('../node_modules/@modelcontextprotocol/sdk/dist/cjs/types.js');
const store = require('./store');

const server = new Server(
  { name: 'spiral-memory', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'spiral_recall',
      description: 'Retrieve memories from the Spiral orbital store. Pass a query to find relevant memories, or leave empty to surface highest-scored memories. Call this at the start of sessions to re-enter the field.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for. Leave empty to retrieve top memories by score.',
          },
          limit: {
            type: 'number',
            description: 'Max memories to return (default 8)',
          },
        },
      },
    },
    {
      name: 'spiral_remember',
      description: 'Write a memory into the Spiral orbital store. Use for insights, context, or anything worth carrying across sessions. Similar memories are merged rather than duplicated.',
      inputSchema: {
        type: 'object',
        required: ['content'],
        properties: {
          content: {
            type: 'string',
            description: 'What to remember.',
          },
          memory_type: {
            type: 'string',
            enum: ['fact', 'preference', 'observation', 'interpretation', 'narrative', 'transient', 'anchor'],
            description: 'Type of memory (default: observation)',
          },
          confidence: {
            type: 'number',
            description: 'Confidence score 0-1 (default 0.7)',
          },
          domain: {
            type: 'string',
            enum: ['operational', 'narrative'],
            description: 'Domain (default: narrative)',
          },
          source: {
            type: 'string',
            description: 'Source label e.g. "session", "user", "inference"',
          },
        },
      },
    },
    {
      name: 'spiral_status',
      description: 'Current state of the Spiral memory field: active/quiet counts, age, db location.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'spiral_forget',
      description: 'Release a memory by id (marks as released, not deleted).',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Memory id to release' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'spiral_recall') {
      const memories = await store.recall(args?.query || '', { limit: args?.limit || 8 });
      if (memories.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }
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
        ? `Merged with existing memory ${result.id} (similarity above threshold).`
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

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
