/**
 * Spiral Memory Store
 * Persistent SQLite-backed memory with orbital scoring logic
 * extracted from Spiral Companion.
 */

const initSqlJs = require('../node_modules/sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.SPIRAL_MEMORY_PATH || path.join(process.env.HOME || '.', '.spiral-memory', 'memory.db');

let db = null;
let SQL = null;

async function getDb() {
  if (db) return db;

  SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'observation',
      source TEXT NOT NULL DEFAULT 'session',
      confidence_score REAL NOT NULL DEFAULT 0.7,
      status TEXT NOT NULL DEFAULT 'active',
      domain TEXT NOT NULL DEFAULT 'narrative',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      last_confirmed_at INTEGER NOT NULL,
      half_life_days REAL NOT NULL DEFAULT 45,
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      intent_bias REAL NOT NULL DEFAULT 0,
      confirmation_prompted INTEGER NOT NULL DEFAULT 0,
      resurface_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  persist();
  return db;
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function uid() {
  return crypto.randomUUID();
}

// --- Scoring (from Spiral's memory-scoring + memory-rotation) ---

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function recencySignal(lastUsedAt, now, halfLifeDays = 21) {
  const ageDays = Math.max(0, (now - lastUsedAt) / MS_PER_DAY);
  return Math.exp(-ageDays / Math.max(0.1, halfLifeDays));
}

function recurrenceSignal(resurfaceCount) {
  return Math.min(Math.log1p(Math.max(0, resurfaceCount)) / Math.log(10), 1);
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function scoreMemory(mem, now) {
  const confidence = clamp(mem.confidence_score, 0, 1);
  const freshness = recencySignal(mem.last_used_at, now, mem.half_life_days);
  const recurrence = recurrenceSignal(mem.resurface_count);
  const confirmation = (mem.requires_confirmation && mem.last_confirmed_at <= mem.created_at) ? 0.55 : 1;
  const base = confidence * 0.38 + freshness * 0.27 + recurrence * 0.13 + 0.22;
  return base * confirmation;
}

// Simple token overlap for dedup
function tokenize(text) {
  const stopWords = new Set(['the','and','for','that','this','with','have','from','you','your','are','was','were','but','not','what','when','where','which','would','could','should','about','into','just']);
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !stopWords.has(t))
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? overlap / union : 0;
}

// --- Public API ---

async function remember(content, options = {}) {
  const database = await getDb();
  const now = Date.now();

  // Check for near-duplicates before writing
  const existing = recall_raw(database);
  const newTokens = tokenize(content);
  for (const mem of existing) {
    if (mem.status === 'released') continue;
    const sim = jaccard(newTokens, tokenize(mem.content));
    if (sim > 0.86) {
      // Too similar — bump resurface count and confidence instead of duplicating
      database.run(
        `UPDATE memories SET resurface_count = resurface_count + 1, last_used_at = ?, confidence_score = MIN(1.0, confidence_score + 0.05), updated_at = ? WHERE id = ?`,
        [now, now, mem.id]
      );
      persist();
      return { merged: true, id: mem.id };
    }
  }

  const id = uid();
  const memType = options.memoryType || 'observation';
  const source = options.source || 'session';
  const confidence = options.confidence ?? 0.7;
  const domain = options.domain || 'narrative';
  const halfLife = options.halfLifeDays ?? 45;

  database.run(
    `INSERT INTO memories (id, content, memory_type, source, confidence_score, status, domain, created_at, updated_at, last_used_at, last_confirmed_at, half_life_days, requires_confirmation, intent_bias, confirmation_prompted, resurface_count)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
    [id, content, memType, source, confidence, domain, now, now, now, now, halfLife]
  );

  persist();
  return { id, created: true };
}

function recall_raw(database) {
  const result = database.exec(`SELECT * FROM memories WHERE status != 'released' ORDER BY last_used_at DESC`);
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

async function recall(query, options = {}) {
  const database = await getDb();
  const now = Date.now();
  const limit = options.limit || 8;

  let memories = recall_raw(database);

  // Score and sort
  const scored = memories.map(m => ({ mem: m, score: scoreMemory(m, now) }));
  scored.sort((a, b) => b.score - a.score);

  // If query provided, filter by token overlap
  let results = scored;
  if (query && query.trim()) {
    const qTokens = tokenize(query);
    results = scored
      .map(s => ({ ...s, overlap: jaccard(qTokens, tokenize(s.mem.content)) }))
      .filter(s => s.overlap > 0.05 || s.score > 0.7)
      .sort((a, b) => (b.overlap * 0.6 + b.score * 0.4) - (a.overlap * 0.6 + a.score * 0.4));
  }

  // Update last_used_at for top results
  const top = results.slice(0, limit);
  for (const { mem } of top) {
    database.run(
      `UPDATE memories SET last_used_at = ?, resurface_count = resurface_count + 1 WHERE id = ?`,
      [now, mem.id]
    );
  }
  persist();

  return top.map(({ mem, score }) => ({
    id: mem.id,
    content: mem.content,
    type: mem.memory_type,
    domain: mem.domain,
    score: Math.round(score * 1000) / 1000,
    age_days: Math.round((now - mem.created_at) / MS_PER_DAY),
    resurface_count: mem.resurface_count,
  }));
}

async function status() {
  const database = await getDb();
  const now = Date.now();
  const all = recall_raw(database);

  const active = all.filter(m => m.status === 'active');
  const quiet = all.filter(m => m.status === 'quiet');

  // Run simple rotation: demote low-scoring active memories
  for (const mem of active) {
    const score = scoreMemory(mem, now);
    if (score < 0.18) {
      database.run(`UPDATE memories SET status = 'quiet', updated_at = ? WHERE id = ?`, [now, mem.id]);
    }
  }
  persist();

  return {
    total: all.length,
    active: active.length,
    quiet: quiet.length,
    db_path: DB_PATH,
    oldest_days: all.length
      ? Math.round((now - Math.min(...all.map(m => m.created_at))) / MS_PER_DAY)
      : 0,
  };
}

async function forget(id) {
  const database = await getDb();
  const now = Date.now();
  database.run(`UPDATE memories SET status = 'released', updated_at = ? WHERE id = ?`, [now, id]);
  persist();
  return { released: true, id };
}

module.exports = { remember, recall, status, forget };
