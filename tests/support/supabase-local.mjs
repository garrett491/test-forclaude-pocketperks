/**
 * A local stand-in for the three Supabase services this site talks to:
 * PostgREST (/rest/v1), GoTrue (/auth/v1) and Storage (/storage/v1).
 *
 * TEST TOOLING ONLY. It is never bundled, never deployed, and never used by
 * the live site. It exists so the real pages and the real admin can be run
 * end to end against the real migrations and the real Row Level Security
 * policies without needing access to the hosted Supabase project.
 *
 * Every request runs inside a transaction as the Postgres role the real
 * service would use (anon, authenticated or service_role), so RLS decides
 * what each caller can see and change, exactly as it does in production.
 *
 * Only the parts of each API this codebase uses are implemented. Embedding
 * follows PostgREST's rules closely enough to catch the mistakes that matter:
 * an embed with no matching foreign key, or with more than one, is an error
 * here just as it is there.
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/pp_e2e node tests/support/supabase-local.mjs
 */
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.SUPABASE_LOCAL_PORT || 54321);
const PGURL = process.env.PGURL || 'postgres://postgres@127.0.0.1:5433/pp_e2e';
const ANON_KEY = process.env.SUPABASE_LOCAL_ANON_KEY || 'local-anon-key';
const SERVICE_KEY = process.env.SUPABASE_LOCAL_SERVICE_KEY || 'local-service-key';
const JWT_SECRET = 'local-jwt-secret-for-tests-only';
const STORAGE_DIR = process.env.SUPABASE_LOCAL_STORAGE || join(process.cwd(), '.supabase-local', 'storage');
/** Set to simulate a paused or unreachable project: every call fails. */
let outage = process.env.SUPABASE_LOCAL_OUTAGE === '1';
/** Request counts, so tests can check how many queries a page makes. */
let requestCount = 0;
let requestLog = [];

const pool = new pg.Pool({ connectionString: PGURL, max: 8 });
// Rebuilding the test database force-closes idle connections. The pool
// drops them and opens fresh ones on the next request; that is not fatal.
pool.on('error', (error) => console.warn('[supabase-local] idle connection closed:', error.message));

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const sig = createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (sig !== parts[2]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Which Postgres role a request runs as, from its Authorization header. */
function callerFor(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const apikey = req.headers.apikey || token;
  if (token === SERVICE_KEY || apikey === SERVICE_KEY) return { role: 'service_role', sub: null };
  const claims = verifyJwt(token);
  if (claims?.sub) return { role: 'authenticated', sub: claims.sub, claims };
  return { role: 'anon', sub: null };
}

/* ------------------------------------------------------------------ */
/* Schema cache                                                        */
/* ------------------------------------------------------------------ */

let schema = null;

async function loadSchema() {
  const client = await pool.connect();
  try {
    const cols = await client.query(`
      select c.relname as table, a.attname as column
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','v') and a.attnum > 0 and not a.attisdropped`);
    const fks = await client.query(`
      select con.conname as name, src.relname as src, tgt.relname as tgt,
             (select attname from pg_attribute where attrelid = con.conrelid and attnum = con.conkey[1]) as src_col,
             (select attname from pg_attribute where attrelid = con.confrelid and attnum = con.confkey[1]) as tgt_col
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_class tgt on tgt.oid = con.confrelid
      join pg_namespace n on n.oid = src.relnamespace
      join pg_namespace tn on tn.oid = tgt.relnamespace
      where con.contype = 'f' and n.nspname = 'public' and tn.nspname = 'public'
        and array_length(con.conkey, 1) = 1`);
    const fns = await client.query(`
      select p.proname as name, p.proretset as retset,
             format_type(p.prorettype, null) as rettype,
             coalesce(p.proargnames, '{}') as argnames,
             array(select format_type(t, null) from unnest(p.proargtypes) t) as argtypes,
             t.typtype as rettypekind
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_type t on t.oid = p.prorettype
      where n.nspname = 'public'`);

    const tables = new Map();
    for (const row of cols.rows) {
      if (!tables.has(row.table)) tables.set(row.table, new Set());
      tables.get(row.table).add(row.column);
    }
    schema = { tables, fks: fks.rows, fns: new Map(fns.rows.map((f) => [f.name, f])) };
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, code, message, details = null, hint = null) {
    super(message);
    Object.assign(this, { status, code, details, hint });
  }
}

function fromPg(error, caller) {
  const map = {
    '23505': 409, '23503': 409, '23502': 400, '23514': 400, '22P02': 400,
    '22007': 400, '22008': 400, '22001': 400, 'P0001': 400, '42703': 400, '42P01': 404,
  };
  let status = map[error.code] ?? 400;
  if (error.code === '42501') status = caller.role === 'anon' ? 401 : 403;
  return new ApiError(status, error.code, error.message, error.detail ?? null, error.hint ?? null);
}

/* ------------------------------------------------------------------ */
/* Select parsing                                                      */
/* ------------------------------------------------------------------ */

function splitTop(text, sep = ',') {
  const out = [];
  let depth = 0, quote = false, cur = '';
  for (const ch of text) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}

function parseSelect(text) {
  const src = (text || '*').replace(/\s+/g, '');
  const nodes = [];
  for (const item of splitTop(src)) {
    if (!item) continue;
    const paren = item.indexOf('(');
    if (paren === -1) {
      const [alias, column] = item.includes(':') ? item.split(':') : [item, item];
      nodes.push({ kind: 'col', alias, column });
      continue;
    }
    const head = item.slice(0, paren);
    const inner = item.slice(paren + 1, -1);
    let alias = null, rest = head;
    if (head.includes(':')) [alias, rest] = head.split(':');
    const [table, ...hints] = rest.split('!');
    const isInner = hints.includes('inner');
    const hint = hints.find((h) => h !== 'inner' && h !== 'left') ?? null;
    nodes.push({ kind: 'embed', alias: alias ?? table, table, hint, inner: isInner, children: parseSelect(inner) });
  }
  return nodes;
}

function resolveRelation(parent, node) {
  const target = node.table;
  if (!schema.tables.has(target)) {
    throw new ApiError(400, 'PGRST200', `Could not find a relationship between '${parent}' and '${target}' in the schema cache`);
  }
  let candidates = [
    ...schema.fks.filter((f) => f.src === parent && f.tgt === target).map((f) => ({ ...f, kind: 'm2o' })),
    ...schema.fks.filter((f) => f.src === target && f.tgt === parent).map((f) => ({ ...f, kind: 'o2m' })),
  ];
  if (node.hint) {
    candidates = candidates.filter((c) => c.name === node.hint || c.src_col === node.hint);
  }
  if (candidates.length === 0) {
    throw new ApiError(400, 'PGRST200', `Could not find a relationship between '${parent}' and '${target}' in the schema cache`);
  }
  if (candidates.length > 1) {
    throw new ApiError(300, 'PGRST201', `Could not embed because more than one relationship was found for '${parent}' and '${target}'`);
  }
  return candidates[0];
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and']);

function unquote(v) {
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

/** One `op.value` expression against a qualified column. */
function condition(colSql, expr, params) {
  let negate = false;
  let rest = expr;
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const dot = rest.indexOf('.');
  const op = rest.slice(0, dot);
  const raw = rest.slice(dot + 1);
  let sql;
  const p = (value) => { params.push(value); return `$${params.length}`; };
  switch (op) {
    case 'eq': sql = `${colSql} = ${p(unquote(raw))}`; break;
    case 'neq': sql = `${colSql} <> ${p(unquote(raw))}`; break;
    case 'gt': sql = `${colSql} > ${p(unquote(raw))}`; break;
    case 'gte': sql = `${colSql} >= ${p(unquote(raw))}`; break;
    case 'lt': sql = `${colSql} < ${p(unquote(raw))}`; break;
    case 'lte': sql = `${colSql} <= ${p(unquote(raw))}`; break;
    case 'like': sql = `${colSql}::text like ${p(unquote(raw).replace(/\*/g, '%'))}`; break;
    case 'ilike': sql = `${colSql}::text ilike ${p(unquote(raw).replace(/\*/g, '%'))}`; break;
    case 'is': {
      const v = raw.toLowerCase();
      sql = v === 'null' ? `${colSql} is null` : v === 'true' ? `${colSql} is true` : `${colSql} is false`;
      break;
    }
    case 'in': {
      const list = splitTop(raw.replace(/^\(|\)$/g, '')).map(unquote);
      sql = list.length ? `${colSql}::text = any(${p(list)}::text[])` : 'false';
      break;
    }
    default: throw new ApiError(400, 'PGRST100', `unsupported operator ${op}`);
  }
  return negate ? `not (${sql})` : sql;
}

function orCondition(alias, table, expr, params) {
  const inner = expr.replace(/^\(|\)$/g, '');
  const parts = splitTop(inner).map((part) => {
    const dot = part.indexOf('.');
    const column = part.slice(0, dot);
    if (!schema.tables.get(table)?.has(column)) throw new ApiError(400, '42703', `column ${table}.${column} does not exist`);
    return condition(`${alias}."${column}"`, part.slice(dot + 1), params);
  });
  return `(${parts.join(' or ')})`;
}

/**
 * Filters grouped by embed path. '' is the top level; 'merchant' is the
 * embed aliased merchant; 'merchant.town' would be one level deeper.
 */
function groupFilters(searchParams) {
  const groups = new Map();
  for (const [key, value] of searchParams) {
    const segments = key.split('.');
    const last = segments[segments.length - 1];
    if (segments.length === 1 && RESERVED.has(key)) {
      if (key === 'or') {
        if (!groups.has('')) groups.set('', []);
        groups.get('').push({ or: value });
      }
      continue;
    }
    const path = segments.slice(0, -1).join('.');
    if (!groups.has(path)) groups.set(path, []);
    if (last === 'or') groups.get(path).push({ or: value });
    else groups.get(path).push({ column: last, expr: value });
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* SQL building                                                        */
/* ------------------------------------------------------------------ */

let aliasCounter = 0;
const nextAlias = () => `t${aliasCounter++}`;

function rowJson(table, alias, nodes, path, filters, params) {
  const pieces = [];
  const pairs = [];
  for (const node of nodes) {
    if (node.kind === 'col') {
      if (node.column === '*') { pieces.push(`to_jsonb(${alias})`); continue; }
      if (!schema.tables.get(table)?.has(node.column)) {
        throw new ApiError(400, '42703', `column ${table}.${node.column} does not exist`);
      }
      pairs.push(`'${node.alias}'`, `${alias}."${node.column}"`);
    } else {
      const childPath = path ? `${path}.${node.alias}` : node.alias;
      pairs.push(`'${node.alias}'`, embedSql(table, alias, node, childPath, filters, params));
    }
  }
  for (let i = 0; i < pairs.length; i += 80) {
    pieces.push(`jsonb_build_object(${pairs.slice(i, i + 80).join(', ')})`);
  }
  return pieces.length ? pieces.join(' || ') : `'{}'::jsonb`;
}

function joinCondition(rel, parentAlias, childAlias) {
  return rel.kind === 'm2o'
    ? `${childAlias}."${rel.tgt_col}" = ${parentAlias}."${rel.src_col}"`
    : `${childAlias}."${rel.src_col}" = ${parentAlias}."${rel.tgt_col}"`;
}

/** Conditions a row at this level must meet: its own filters plus inner embeds. */
function levelConditions(table, alias, nodes, path, filters, params) {
  const conds = [];
  for (const f of filters.get(path) ?? []) {
    if (f.or) { conds.push(orCondition(alias, table, f.or, params)); continue; }
    if (!schema.tables.get(table)?.has(f.column)) {
      throw new ApiError(400, '42703', `column ${table}.${f.column} does not exist`);
    }
    conds.push(condition(`${alias}."${f.column}"`, f.expr, params));
  }
  for (const node of nodes) {
    if (node.kind !== 'embed' || !node.inner) continue;
    const rel = resolveRelation(table, node);
    const child = nextAlias();
    const childPath = path ? `${path}.${node.alias}` : node.alias;
    const inner = levelConditions(node.table, child, node.children, childPath, filters, params);
    conds.push(`exists (select 1 from public."${node.table}" ${child} where ${[joinCondition(rel, alias, child), ...inner].join(' and ')})`);
  }
  return conds;
}

function embedSql(parentTable, parentAlias, node, path, filters, params) {
  const rel = resolveRelation(parentTable, node);
  const child = nextAlias();
  const conds = [joinCondition(rel, parentAlias, child),
    ...levelConditions(node.table, child, node.children, path, filters, params)];
  const json = rowJson(node.table, child, node.children, path, filters, params);
  if (rel.kind === 'm2o') {
    return `(select ${json} from public."${node.table}" ${child} where ${conds.join(' and ')} limit 1)`;
  }
  return `coalesce((select jsonb_agg(${json}) from public."${node.table}" ${child} where ${conds.join(' and ')}), '[]'::jsonb)`;
}

function orderSql(alias, table, order) {
  if (!order) return '';
  const parts = splitTop(order).map((item) => {
    const [column, ...mods] = item.split('.');
    if (!schema.tables.get(table)?.has(column)) throw new ApiError(400, '42703', `column ${table}.${column} does not exist`);
    let sql = `${alias}."${column}"`;
    if (mods.includes('desc')) sql += ' desc';
    if (mods.includes('nullsfirst')) sql += ' nulls first';
    if (mods.includes('nullslast')) sql += ' nulls last';
    return sql;
  });
  return parts.length ? ` order by ${parts.join(', ')}` : '';
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

async function asCaller(caller, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${caller.role}`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [caller.sub ?? '']);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error instanceof ApiError ? error : fromPg(error, caller);
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

function prefer(req) {
  return String(req.headers.prefer || '');
}

async function restRead(req, url, table, caller) {
  if (!schema.tables.has(table)) throw new ApiError(404, '42P01', `relation "public.${table}" does not exist`);
  aliasCounter = 0;
  const params = [];
  const nodes = parseSelect(url.searchParams.get('select'));
  const filters = groupFilters(url.searchParams);
  const alias = nextAlias();
  const json = rowJson(table, alias, nodes, '', filters, params);
  const conds = levelConditions(table, alias, nodes, '', filters, params);
  const where = conds.length ? ` where ${conds.join(' and ')}` : '';
  const limit = url.searchParams.get('limit');
  const offset = url.searchParams.get('offset');

  const sql = `select ${json} as row from public."${table}" ${alias}${where}`
    + orderSql(alias, table, url.searchParams.get('order'))
    + (limit ? ` limit ${parseInt(limit, 10)}` : '')
    + (offset ? ` offset ${parseInt(offset, 10)}` : '');
  // The count has its own parameter list: it references only the WHERE
  // clause, and Postgres refuses parameters a statement never uses.
  const countParams = [];
  const countAlias = nextAlias();
  const countConds = levelConditions(table, countAlias, nodes, '', filters, countParams);
  const countSql = `select count(*)::int as n from public."${table}" ${countAlias}`
    + (countConds.length ? ` where ${countConds.join(' and ')}` : '');
  const wantCount = /count=(exact|planned|estimated)/.test(prefer(req));

  return asCaller(caller, async (client) => {
    const rows = req.method === 'HEAD' ? [] : (await client.query(sql, params)).rows.map((r) => r.row);
    const total = wantCount ? (await client.query(countSql, countParams)).rows[0].n : null;
    return { rows, total, offset: offset ? parseInt(offset, 10) : 0 };
  });
}

function pickColumns(rows, selectText) {
  if (!selectText || selectText.trim() === '*') return rows;
  const nodes = parseSelect(selectText).filter((n) => n.kind === 'col');
  if (nodes.some((n) => n.column === '*')) return rows;
  return rows.map((row) => Object.fromEntries(nodes.map((n) => [n.alias, row[n.column]])));
}

/**
 * What a write hands back. Like PostgREST: nothing unless the caller asked
 * for a representation, and then only the columns in ?select=. Reading back
 * a whole row would need SELECT on every column, which a column-restricted
 * table (portal_users) deliberately does not grant.
 */
function returning(req, url, table, alias) {
  if (!/return=representation/.test(prefer(req))) return `'{}'::jsonb`;
  const nodes = parseSelect(url.searchParams.get('select'));
  if (!nodes.length || nodes.some((n) => n.kind !== 'col' || n.column === '*')) return `to_jsonb(${alias}.*)`;
  return rowJson(table, alias, nodes, '', new Map(), []);
}

async function restWrite(req, url, table, caller, body) {
  if (!schema.tables.has(table)) throw new ApiError(404, '42P01', `relation "public.${table}" does not exist`);
  aliasCounter = 0;
  const params = [];
  const pref = prefer(req);
  const alias = nextAlias();
  const known = schema.tables.get(table);

  if (req.method === 'POST') {
    const rows = Array.isArray(body) ? body : [body];
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    for (const c of columns) if (!known.has(c)) throw new ApiError(400, 'PGRST204', `Could not find the '${c}' column of '${table}' in the schema cache`);
    params.push(JSON.stringify(rows));
    const colList = columns.map((c) => `"${c}"`).join(', ');
    let sql = `insert into public."${table}" as ins (${colList}) select ${colList} from jsonb_populate_recordset(null::public."${table}", $1::jsonb)`;
    const onConflict = url.searchParams.get('on_conflict');
    if (/resolution=ignore-duplicates/.test(pref)) {
      sql += onConflict ? ` on conflict (${onConflict.split(',').map((c) => `"${c}"`).join(', ')}) do nothing` : ' on conflict do nothing';
    } else if (/resolution=merge-duplicates/.test(pref)) {
      const target = (onConflict || 'id').split(',').map((c) => `"${c}"`).join(', ');
      sql += ` on conflict (${target}) do update set ${columns.map((c) => `"${c}" = excluded."${c}"`).join(', ')}`;
    }
    sql += ` returning ${returning(req, url, table, 'ins')} as row`;
    return asCaller(caller, async (client) => (await client.query(sql, params)).rows.map((r) => r.row));
  }

  const filters = groupFilters(url.searchParams);
  const conds = levelConditions(table, alias, [], '', filters, params);
  const where = conds.length ? ` where ${conds.join(' and ')}` : '';

  if (req.method === 'PATCH') {
    const columns = Object.keys(body || {});
    for (const c of columns) if (!known.has(c)) throw new ApiError(400, 'PGRST204', `Could not find the '${c}' column of '${table}' in the schema cache`);
    if (!columns.length) return [];
    params.push(JSON.stringify(body));
    const n = params.length;
    const sql = `update public."${table}" ${alias} set ${columns.map((c) => `"${c}" = src."${c}"`).join(', ')}
      from jsonb_populate_record(null::public."${table}", $${n}::jsonb) src${where}
      returning ${returning(req, url, table, alias)} as row`;
    return asCaller(caller, async (client) => (await client.query(sql, params)).rows.map((r) => r.row));
  }

  if (req.method === 'DELETE') {
    const sql = `delete from public."${table}" ${alias}${where} returning ${returning(req, url, table, alias)} as row`;
    return asCaller(caller, async (client) => (await client.query(sql, params)).rows.map((r) => r.row));
  }
  throw new ApiError(405, 'PGRST000', 'method not allowed');
}

async function rpc(fnName, caller, args) {
  const fn = schema.fns.get(fnName);
  if (!fn) throw new ApiError(404, 'PGRST202', `Could not find the function public.${fnName}`);
  const params = [];
  const named = Object.entries(args || {}).map(([name, value]) => {
    const index = fn.argnames.indexOf(name);
    const type = fn.argtypes[index] ?? 'text';
    params.push(value);
    return `"${name}" => $${params.length}::${type}`;
  });
  const call = `public."${fnName}"(${named.join(', ')})`;
  const sql = fn.retset || fn.rettypekind === 'c'
    ? `select to_jsonb(r) as row from ${call} r`
    : `select to_jsonb(${call}) as row`;
  return asCaller(caller, async (client) => {
    const rows = (await client.query(sql, params)).rows.map((r) => r.row);
    return fn.retset ? rows : rows[0] ?? null;
  });
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function session(user) {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600;
  const claims = {
    sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated',
    iat: now, exp: now + expiresIn, session_id: randomUUID(),
  };
  return {
    access_token: signJwt(claims),
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: signJwt({ ...claims, exp: now + 86_400 * 7, refresh: true }),
    user: userJson(user),
  };
}

function userJson(user) {
  return {
    id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email,
    email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

async function authRoute(req, url, body) {
  const path = url.pathname.replace('/auth/v1', '');
  if (path === '/token') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const { rows } = await pool.query(
        `select id, email from auth.users where lower(email) = lower($1) and test_password = $2`,
        [body?.email ?? '', body?.password ?? '']);
      if (!rows[0]) return [400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' }];
      return [200, session(rows[0])];
    }
    if (grant === 'refresh_token') {
      const claims = verifyJwt(body?.refresh_token);
      if (!claims?.refresh) return [400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' }];
      return [200, session({ id: claims.sub, email: claims.email })];
    }
  }
  if (path === '/user' && req.method === 'GET') {
    const claims = verifyJwt(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!claims?.sub) return [401, { code: 401, msg: 'invalid JWT', error_code: 'bad_jwt' }];
    const { rows } = await pool.query('select id, email from auth.users where id = $1', [claims.sub]);
    if (!rows[0]) return [404, { code: 404, msg: 'User not found' }];
    return [200, userJson(rows[0])];
  }
  if (path === '/user' && req.method === 'PUT') {
    const claims = verifyJwt(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!claims?.sub) return [401, { code: 401, msg: 'invalid JWT', error_code: 'bad_jwt' }];
    if (body?.password !== undefined) {
      if (String(body.password).length < 6) return [422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' }];
      await pool.query('update auth.users set test_password = $2 where id = $1', [claims.sub, String(body.password)]);
    }
    const { rows } = await pool.query('select id, email from auth.users where id = $1', [claims.sub]);
    return [200, userJson(rows[0])];
  }
  if (path === '/verify' && req.method === 'POST') {
    const entry = linkTokens.get(body?.token_hash ?? '');
    if (!entry || entry.expires < Date.now()) {
      return [403, { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' }];
    }
    linkTokens.delete(body.token_hash);
    return [200, session({ id: entry.userId, email: entry.email })];
  }
  // Admin API: service role only, exactly as on Supabase.
  if (path.startsWith('/admin/')) {
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (key !== SERVICE_KEY) return [401, { code: 401, msg: 'This endpoint requires a valid service role key' }];
    if (path === '/admin/users' && req.method === 'POST') {
      const email = String(body?.email ?? '').toLowerCase();
      const { rows: found } = await pool.query('select id from auth.users where lower(email) = $1', [email]);
      if (found[0]) return [422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }];
      const { rows } = await pool.query(
        'insert into auth.users (email, test_password) values ($1, $2) returning id, email', [email, body?.password ?? null]);
      return [200, userJson(rows[0])];
    }
    if (path === '/admin/generate_link' && req.method === 'POST') {
      const email = String(body?.email ?? '').toLowerCase();
      const { rows } = await pool.query('select id, email from auth.users where lower(email) = $1', [email]);
      if (!rows[0]) return [404, { code: 404, error_code: 'user_not_found', msg: 'User with this email not found' }];
      const hashed = randomUUID().replace(/-/g, '');
      linkTokens.set(hashed, { userId: rows[0].id, email: rows[0].email, expires: Date.now() + 3_600_000 });
      return [200, {
        ...userJson(rows[0]),
        action_link: `http://127.0.0.1:${PORT}/auth/v1/verify?token=${hashed}&type=${body?.type}`,
        email_otp: '123456', hashed_token: hashed, redirect_to: body?.redirect_to ?? '', verification_type: body?.type,
      }];
    }
  }
  if (path === '/logout') return [204, null];
  if (path === '/recover') return [200, {}];
  return [404, { msg: 'not found' }];
}

/** One-time sign-in links made through the admin API. */
const linkTokens = new Map();

/* ------------------------------------------------------------------ */
/* Email catcher: stands in for Resend when RESEND_API_URL points here */
/* ------------------------------------------------------------------ */

const sentEmails = [];

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif', svg: 'image/svg+xml' };

async function storageRoute(req, url, raw, caller) {
  const path = decodeURIComponent(url.pathname.replace('/storage/v1', ''));
  const publicMatch = path.match(/^\/object\/public\/([^/]+)\/(.+)$/);
  if (publicMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const file = join(STORAGE_DIR, publicMatch[1], publicMatch[2]);
    if (!existsSync(file)) return [404, { statusCode: '404', error: 'not_found', message: 'Object not found' }];
    const ext = file.split('.').pop().toLowerCase();
    return [200, readFileSync(file), MIME[ext] ?? 'application/octet-stream'];
  }
  // Transforms are a paid-plan feature; on Free they fail. Mirror that.
  if (path.startsWith('/render/image/')) {
    return [403, { statusCode: '403', error: 'FeatureNotEnabled', message: 'Image transformations are not enabled on this plan' }];
  }
  const objectMatch = path.match(/^\/object\/([^/]+)\/(.+)$/);
  if (objectMatch && req.method === 'POST') {
    const [, bucket, name] = objectMatch;
    let bytes = raw;
    const type = String(req.headers['content-type'] || '');
    if (type.startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
      const file = [...form.values()].find((v) => typeof v === 'object');
      bytes = Buffer.from(await file.arrayBuffer());
    }
    await asCaller(caller, (client) => client.query(
      'insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name]));
    const file = join(STORAGE_DIR, bucket, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return [200, { Key: `${bucket}/${name}`, Id: randomUUID() }];
  }
  const bucketMatch = path.match(/^\/object\/([^/]+)$/);
  if (bucketMatch && req.method === 'DELETE') {
    const bucket = bucketMatch[1];
    const prefixes = JSON.parse(raw.toString() || '{}').prefixes ?? [];
    await asCaller(caller, (client) => client.query(
      'delete from storage.objects where bucket_id = $1 and name = any($2::text[])', [bucket, prefixes]));
    for (const name of prefixes) rmSync(join(STORAGE_DIR, bucket, name), { force: true });
    return [200, prefixes.map((name) => ({ name }))];
  }
  return [404, { statusCode: '404', error: 'not_found', message: 'not found' }];
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function send(res, status, body, contentType = 'application/json', extra = {}) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Expose-Headers': 'content-range',
    ...extra,
  };
  if (body === null || body === undefined || status === 204) {
    res.writeHead(status, headers);
    return res.end();
  }
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { ...headers, 'Content-Type': contentType, 'Content-Length': payload.length });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return send(res, 204, null);

  // Test control: flip the simulated outage on and off.
  if (url.pathname === '/__control/outage') {
    outage = url.searchParams.get('on') === '1';
    return send(res, 200, { outage });
  }
  if (url.pathname === '/__email' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sentEmails.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
    return send(res, 200, { id: randomUUID() });
  }
  if (url.pathname === '/__control/emails') {
    const list = sentEmails.slice();
    if (url.searchParams.get('clear')) sentEmails.length = 0;
    return send(res, 200, list);
  }
  if (url.pathname === '/__control/stats') {
    const body = { count: requestCount, paths: requestLog };
    if (url.searchParams.get('reset') === '1') { requestCount = 0; requestLog = []; }
    return send(res, 200, body);
  }
  if (!url.pathname.startsWith('/__control')) { requestCount++; requestLog.push(`${req.method} ${url.pathname}${url.search.slice(0, 90)}`); }
  if (url.pathname === '/__control/reload') {
    await loadSchema();
    return send(res, 200, { ok: true });
  }
  if (outage) {
    return send(res, 503, { message: 'Service unavailable (simulated outage)' });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const caller = callerFor(req);

  try {
    if (url.pathname.startsWith('/auth/v1')) {
      const body = raw.length ? JSON.parse(raw.toString()) : null;
      const [status, payload] = await authRoute(req, url, body);
      return send(res, status, payload);
    }
    if (url.pathname.startsWith('/storage/v1')) {
      const [status, payload, type] = await storageRoute(req, url, raw, caller);
      return send(res, status, payload, type);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fnName = url.pathname.slice('/rest/v1/rpc/'.length);
      const args = raw.length ? JSON.parse(raw.toString()) : Object.fromEntries(url.searchParams);
      return send(res, 200, await rpc(fnName, caller, args));
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.slice('/rest/v1/'.length);
      const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object');

      if (req.method === 'GET' || req.method === 'HEAD') {
        const { rows, total, offset } = await restRead(req, url, table, caller);
        const range = rows.length ? `${offset}-${offset + rows.length - 1}` : '*';
        const extra = { 'Content-Range': `${range}/${total ?? '*'}` };
        if (req.method === 'HEAD') return send(res, 200, null, 'application/json', extra);
        if (wantsObject) {
          if (rows.length !== 1) throw new ApiError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${rows.length} rows`);
          return send(res, 200, rows[0], 'application/json', extra);
        }
        return send(res, 200, rows, 'application/json', extra);
      }

      const body = raw.length ? JSON.parse(raw.toString()) : null;
      const rows = await restWrite(req, url, table, caller, body);
      const status = req.method === 'POST' ? 201 : 200;
      if (!/return=representation/.test(prefer(req))) return send(res, req.method === 'POST' ? 201 : 204, null);
      const picked = pickColumns(rows, url.searchParams.get('select'));
      if (wantsObject) {
        if (picked.length !== 1) throw new ApiError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned');
        return send(res, status, picked[0]);
      }
      return send(res, status, picked);
    }
    return send(res, 404, { message: 'not found' });
  } catch (error) {
    if (error instanceof ApiError) {
      return send(res, error.status, { code: error.code, message: error.message, details: error.details, hint: error.hint });
    }
    console.error('[supabase-local] unexpected', error);
    return send(res, 500, { code: 'XX000', message: String(error?.message ?? error) });
  }
});

await loadSchema();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[supabase-local] listening on http://127.0.0.1:${PORT} (db ${PGURL})`);
});
