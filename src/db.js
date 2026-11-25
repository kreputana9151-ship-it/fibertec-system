require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=Asia/Manila',
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const QUERY_CACHE_TTL_MS = 20000;
const QUERY_CACHE_MAX_ENTRIES = 256;
const queryCache = new Map();

function isReadOnlyQuery(text) {
  const sql = String(text || '').trim();
  if (!/^(SELECT|WITH)\b/i.test(sql)) return false;
  if (/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|CALL|NEXTVAL|SETVAL)\b/i.test(sql)) return false;
  if (/\b(purge_old_records|pg_advisory_[a-z_]+|pg_notify|set_config|lo_import|lo_unlink)\s*\(/i.test(sql)) return false;
  if (/\bFOR\s+(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/i.test(sql)) return false;
  return true;
}

function cloneValue(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((copy, key) => {
      copy[key] = cloneValue(value[key]);
      return copy;
    }, {});
  }
  return value;
}

function cloneResult(result) {
  return { ...result, rows: result.rows.map(cloneValue) };
}

function invalidateQueryCache() {
  queryCache.clear();
}

function pruneQueryCache(now) {
  for (const [key, entry] of queryCache) {
    if (entry.expiresAt <= now) queryCache.delete(key);
  }
  while (queryCache.size >= QUERY_CACHE_MAX_ENTRIES) {
    queryCache.delete(queryCache.keys().next().value);
  }
}

async function query(text, params) {
  const cacheable = isReadOnlyQuery(text);
  const key = cacheable ? JSON.stringify([text, params || []]) : null;
  const now = Date.now();
  if (cacheable) {
    const cached = queryCache.get(key);
    if (cached && cached.expiresAt > now) return cloneResult(cached.result);
    if (cached) queryCache.delete(key);
  }

  const result = await pool.query(text, params);
  if (cacheable) {
    pruneQueryCache(now);
    queryCache.set(key, { result: cloneResult(result), expiresAt: now + QUERY_CACHE_TTL_MS });
  } else {
    invalidateQueryCache();
  }
  return result;
}

// run several queries in one transaction (all succeed or all roll back)
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    invalidateQueryCache();
    return out;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Database transaction rollback failed:', rollbackError && (rollbackError.code || rollbackError.name) || 'Error');
    }
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, query, tx, invalidateQueryCache };
