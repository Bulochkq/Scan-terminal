// Прогін 001 → (002) → 003 → 004 у PGlite з імітацією Supabase.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'fs';

const ROOT = 'C:/Users/ustym/OneDrive/Desktop/Terminal Scan test/supabase/migrations/';
const withOld = process.argv[2] === 'with002';
let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } }

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create schema if not exists extensions; create schema if not exists auth;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  end $$;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, encrypted_password text,
    raw_user_meta_data jsonb default '{}'::jsonb, last_sign_in_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`);
const run = f => db.exec(fs.readFileSync(ROOT + f, 'utf8'));
await run('001_init.sql');
if (withOld) await run('002_table_editor.sql');
await run('003_accounts_roles.sql');

// дані «до 004»: два склади, в одному вже скановано
async function as(uid) { await db.exec(uid ? `set request.jwt.claim.sub = '${uid}'` : `reset request.jwt.claim.sub`); }
async function q(sql, params) { try { const r = await db.query(sql, params || []); return { v: r.rows[0] ? Object.values(r.rows[0])[0] : null }; } catch (e) { return { err: e.message }; } }
async function signup(email) { const r = await db.query(`insert into auth.users(email) values ($1) returning id`, [email]); return r.rows[0].id; }

await q(`select invite_owner('owner@t.sk', 'Majiteľ')`);
const owner = await signup('owner@t.sk');
await as(owner);
await q(`select api_invite_save('admin@t.sk', 'Adam', 'admin')`);
await q(`select api_invite_save('w@t.sk', 'Peter', 'member')`);
await as(null);
const admin = await signup('admin@t.sk'), worker = await signup('w@t.sk');
await as(owner);
const sA = (await q(`select api_sheet_create('Hayes')`)).v.id;
const sB = (await q(`select api_sheet_create('Shimano')`)).v.id;
await q(`select api_import(${sA}, '[{"plu":"1","name":"A","plan":5},{"plu":"2","name":"B","plan":2}]'::jsonb, 'replace', true)`);
await q(`select api_import(${sB}, '[{"plu":"9","name":"Z","plan":1}]'::jsonb, 'replace', true)`);
const itA = (await db.query(`select id from items where sheet_id = ${sA} order by id limit 1`)).rows[0].id;
const itB = (await db.query(`select id from items where sheet_id = ${sB} limit 1`)).rows[0].id;
await as(worker);
await q(`select api_scan('op_pre004_01', ${itA}, 3, 'scan', '')`);

// ---------------------------------------------------------- 004
const res = await db.exec(fs.readFileSync(ROOT + '004_sheets_status.sql', 'utf8'));
const chk = res[res.length - 1].rows;
ok(chk.length === 2 && chk.find(r => r.sklad === 'Hayes').stav === 'Prebieha' && chk.find(r => r.sklad === 'Shimano').stav === 'Príprava',
   'existing sheets got status by scans', chk);
await db.exec(fs.readFileSync(ROOT + '004_sheets_status.sql', 'utf8'));
ok(true, 'rerun ok');
const st2 = (await db.query(`select name, status from sheets order by name`)).rows;
ok(st2[0].status === 'active' && st2[1].status === 'prep', 'rerun keeps statuses', st2);

const priv = (await db.query(`select p.proname, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') b
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'api\\_%'`)).rows;
ok(priv.length >= 24 && priv.every(r => !r.a && r.b), 'api_* only for authenticated', priv.filter(r => r.a || !r.b));
for (const f of ['status_label_(text)', 'invite_owner(text,text)', 'me_()']) {
  const r = (await db.query(`select has_function_privilege('anon', '${f}', 'execute') a, has_function_privilege('authenticated', '${f}', 'execute') b`)).rows[0];
  ok(!r.a && !r.b, 'private ' + f, r);
}

// init зі статусом
await as(worker);
let r = await q(`select api_init()`);
ok(r.v && r.v.sheets.every(s => s.status) && r.v.sheets.find(s => s.name === 'Hayes').status === 'active', 'init has status', r.v && r.v.sheets);
r = await q(`select api_sheets()`);
ok(r.err && /^ROLE:/.test(r.err), 'member cannot list sheets overview', r);
r = await q(`select api_sheet_update(${sA}, 'X', null)`);
ok(r.err && /^ROLE:/.test(r.err), 'member cannot rename', r);

// перший скан у «Príprava» → «Prebieha»
r = await q(`select api_scan('op_004_scanB', ${itB}, 1, 'scan', '')`);
ok(r.v && r.v.newReal === 1, 'scan in prep sheet', r);
ok((await db.query(`select status from sheets where id = ${sB}`)).rows[0].status === 'active', 'prep → active on first scan');

// огляд складів
await as(admin);
r = await q(`select api_sheets()`);
const H = r.v && r.v.sheets.find(s => s.name === 'Hayes');
ok(H && H.items === 2 && Number(H.plan) === 7 && Number(H.real) === 3 && H.done === 0 && Number(H.capped) === 3, 'overview numbers', H);
ok(H && H.created && H.last && H.lastBy === 'Peter' && H.lastAction === 'SKEN' && H.lastTs > 0, 'overview last activity', H);

// перейменування + стан
r = await q(`select api_sheet_update(${sA}, '  Hayes 2026 ', 'done')`);
ok(r.v && r.v.msg === 'Uložené.', 'rename + status', r);
const sa = (await db.query(`select name, status from sheets where id = ${sA}`)).rows[0];
ok(sa.name === 'Hayes 2026' && sa.status === 'done', 'renamed & done', sa);
const lg = (await db.query(`select name, old_val, new_val, worker from log where action = 'SKLAD' order by id`)).rows;
ok(lg.length === 2 && lg[0].old_val === 'Hayes' && lg[0].new_val === 'Hayes 2026' && lg[1].old_val === 'Prebieha' && lg[1].new_val === 'Dokončený' && lg[1].worker === 'Adam',
   'rename/status logged with labels', lg);
r = await q(`select api_sheet_update(${sA}, 'Shimano', null)`);
ok(r.err && /už existuje/.test(r.err), 'duplicate name rejected', r);
r = await q(`select api_sheet_update(${sA}, null, 'zly')`);
ok(r.err && /Neplatný stav/.test(r.err), 'bad status rejected', r);
r = await q(`select api_sheet_update(${sA}, null, 'archived')`);
ok(r.v, 'archive', r);
await as(worker);
r = await q(`select api_scan('op_004_after_done', ${itA}, 1, 'scan', '')`);
ok(r.v && (await db.query(`select status from sheets where id = ${sA}`)).rows[0].status === 'archived', 'scan does not change archived/done status', r);

// бекап після перейменування → той самий склад
await as(admin);
await q(`select api_items_save(${sA}, '[{"op":"delete","id":${itA}}]'::jsonb)`);   // робить бекап
const bk = (await db.query(`select id, sheet_name from backups where sheet_id = ${sA} order by id desc limit 1`)).rows[0];
await q(`select api_sheet_update(${sA}, 'Hayes nový názov', null)`);
r = await q(`select api_backup_restore(${bk.id})`);
ok(r.v && /Hayes nový názov/.test(r.v.msg), 'restore into renamed sheet (by id)', r);
const cnt = (await db.query(`select count(*)::int c from sheets`)).rows[0].c;
ok(cnt === 2, 'no extra sheet created', cnt);
ok((await db.query(`select count(*)::int c from items where sheet_id = ${sA}`)).rows[0].c === 2, 'items restored into same sheet');

// журнал стирає лише власник
r = await q(`select api_logs_clear()`);
ok(r.err && /^ROLE:/.test(r.err), 'admin cannot clear logs', r);
await as(owner);
r = await q(`select api_logs_clear()`);
ok(r.v && /vymazané/.test(r.v.msg), 'owner clears logs', r);
// після очищення журналу «востаннє» береться з позицій
await as(admin);
r = await q(`select api_sheets()`);
const H2 = r.v.sheets.find(s => s.id === String(sA));
ok(H2 && H2.last && H2.lastBy === 'Obnova' && H2.lastAction === '', 'last activity falls back to items after log clear', H2);

console.log((withOld ? '[001→002→003→004] ' : '[001→003→004] ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
