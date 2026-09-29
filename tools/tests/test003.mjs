// Прогін міграцій 001 → (002) → 003 у PGlite з імітацією Supabase (auth.users, auth.uid()).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'fs';

const ROOT = 'C:/Users/ustym/OneDrive/Desktop/Terminal Scan test/supabase/migrations/';
const withOld = process.argv[2] === 'with002';
let pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } }

const db = new PGlite({ extensions: { pgcrypto } });

await db.exec(`
  create schema if not exists extensions;
  create schema if not exists auth;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  end $$;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, encrypted_password text,
    raw_user_meta_data jsonb default '{}'::jsonb, last_sign_in_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`);

async function run(file) { await db.exec(fs.readFileSync(ROOT + file, 'utf8')); }
await run('001_init.sql');
if (withOld) await run('002_table_editor.sql');
const mig = fs.readFileSync(ROOT + '003_accounts_roles.sql', 'utf8');
const res = await db.exec(mig);
const check = res[res.length - 1].rows;
ok(check.length >= 20, 'check query rows', check.length);
ok(check.every(r => r.anon_moze === false), 'anon cannot execute any api_*', check.filter(r => r.anon_moze));
ok(check.every(r => r.prihlaseny_moze === true), 'authenticated can execute every api_*', check.filter(r => !r.prihlaseny_moze));
// повторний запуск нічого не псує
await db.exec(mig);
ok(true, 'rerun ok');

// приватні функції недоступні anon/authenticated
for (const f of ['invite_owner(text,text)', 'me_()', 'require_role_(text)', 'backup_sheet_(bigint,text)', 'handle_new_user()', 'log_account_(profiles,text,text,text)']) {
  const r = await db.query(`select has_function_privilege('anon', '${f}', 'execute') a, has_function_privilege('authenticated', '${f}', 'execute') b`);
  ok(!r.rows[0].a && !r.rows[0].b, 'private ' + f + ' hidden', r.rows[0]);
}
const oldLeft = await db.query(`select proname, pg_get_function_identity_arguments(oid) args from pg_proc where pronamespace='public'::regnamespace and (pg_get_function_identity_arguments(oid) like '%p_pin%' or proname in ('api_auth','api_user_add','api_user_del','set_admin_pin','check_pin_','require_pin_'))`);
ok(oldLeft.rows.length === 0, 'no PIN functions left', oldLeft.rows);

// ---------------------------------------------------------- helpers
async function as(uid) { await db.exec(uid ? `set request.jwt.claim.sub = '${uid}'` : `reset request.jwt.claim.sub`); }
async function q(sql, params) {
  try { const r = await db.query(sql, params || []); return { v: r.rows[0] ? Object.values(r.rows[0])[0] : null }; }
  catch (e) { return { err: e.message }; }
}
async function signup(email, pw = 'secret1') {
  try {
    const r = await db.query(`insert into auth.users(email, encrypted_password) values ($1, extensions.crypt($2, extensions.gen_salt('bf'))) returning id`, [email, pw]);
    return { id: r.rows[0].id };
  } catch (e) { return { err: e.message }; }
}

// ---------------------------------------------------------- без входу
await as(null);
let r = await q(`select api_init()`);
ok(r.err && /^AUTH: Nie ste prihlásený/.test(r.err), 'anon api_init → AUTH', r);

// ---------------------------------------------------------- реєстрація без запрошення
r = await signup('random@x.sk');
ok(r.err && /nemá pozvánku/.test(r.err), 'signup without invite rejected', r);

// ---------------------------------------------------------- власник
r = await q(`select invite_owner('Owner@Test.sk', 'Majiteľ')`);
ok(r.v && /Pozvánka/.test(r.v), 'invite_owner', r);
const owner = await signup('owner@test.sk');
ok(owner.id, 'owner signup', owner);
await as(owner.id);
r = await q(`select api_init()`);
ok(r.v && r.v.me.role === 'owner' && r.v.me.name === 'Majiteľ', 'owner api_init me', r);

r = await q(`select api_sheet_create('Test')`); const sheetId = r.v && r.v.id;
ok(sheetId, 'owner creates sheet', r);
r = await q(`select api_import($1::bigint, $2::jsonb, 'replace', true)`, [sheetId, JSON.stringify([
  { brand: 'B', plu: '001', name: 'Item 1', code: 'C1', ean: '111', plan: 5 },
  { brand: 'B', plu: '002', name: 'Item 2', code: 'C2', ean: '222', plan: 3 }])]);
ok(r.v && r.v.count === 2, 'import 2 rows', r);
r = await q(`select api_import_done($1::bigint, 2, 'replace')`, [sheetId]);
ok(r.v && /Import hotový/.test(r.v.msg), 'import done', r);
r = await q(`select api_items($1::bigint)`, [sheetId]);
const items = r.v.data; const it1 = items[0][0], it2 = items[1][0];
ok(items.length === 2, 'items loaded', r);

// ---------------------------------------------------------- люди
r = await q(`select api_invite_save('admin@test.sk', 'Adam Admin', 'admin')`);
ok(r.v && /Pozvánka/.test(r.v.msg), 'owner invites admin', r);
r = await q(`select api_invite_save('worker@test.sk', 'Peter Pracovník', 'member')`);
ok(r.v, 'owner invites member', r);
const admin = await signup('ADMIN@test.sk');
const worker = await signup('worker@test.sk');
ok(admin.id && worker.id, 'invited signups ok', [admin, worker]);
r = await signup('worker@test.sk');
ok(r.err, 'second signup same email fails', r);

// ---------------------------------------------------------- pracovník
await as(worker.id);
r = await q(`select api_init()`);
ok(r.v && r.v.me.role === 'member' && r.v.me.name === 'Peter Pracovník', 'member me', r);
r = await q(`select api_scan('op_test_0001', $1::bigint, 1, 'scan', '29.09.2026 10:00:00')`, [it1]);
ok(r.v && r.v.newReal === 1, 'member scans +1', r);
r = await q(`select api_scan('op_test_0001', $1::bigint, 1, 'scan', '29.09.2026 10:00:00')`, [it1]);
ok(r.v && r.v.duplicate === true && r.v.newReal === 1, 'repeat op is idempotent', r);
r = await q(`select api_scan('op_test_0002', $1::bigint, 2, 'manual', '')`, [it1]);
ok(r.v && r.v.newReal === 3, 'member manual +2', r);
r = await q(`select api_note($1::bigint, 'chýba krabica')`, [it1]);
ok(r.v && r.v.note === 'chýba krabica', 'member note', r);
r = await q(`select worker, user_id::text from log where action = 'SKEN' order by id desc limit 1`);
const lg = (await db.query(`select worker, user_id::text u from log where action = 'SKEN' order by id desc limit 1`)).rows[0];
ok(lg.worker === 'Peter Pracovník' && lg.u === worker.id, 'log signed from login, not browser', lg);
for (const [sql, name] of [
  [`select api_sheet_create('X')`, 'sheet_create'], [`select api_sheet_delete(${sheetId})`, 'sheet_delete'],
  [`select api_items_save(${sheetId}, '[]'::jsonb)`, 'items_save'], [`select api_import(${sheetId}, '[]'::jsonb, 'merge', false)`, 'import'],
  [`select api_backup_list()`, 'backup_list'], [`select api_logs_all()`, 'logs_all'], [`select api_logs_clear()`, 'logs_clear'],
  [`select api_people()`, 'people'], [`select api_invite_save('a@b.sk','A','member')`, 'invite_save'],
  [`select api_person_password('${admin.id}', 'hacked1')`, 'person_password']]) {
  r = await q(sql);
  ok(r.err && /^ROLE: /.test(r.err), 'member blocked: ' + name, r);
}
r = await q(`select api_logs($1::bigint, 50)`, [sheetId]);
ok(r.v && r.v.logs.length >= 3, 'member reads sheet history', r);

// ---------------------------------------------------------- správca
await as(admin.id);
r = await q(`select api_people()`);
ok(r.v && r.v.people.length === 3, 'admin sees people', r);
ok(r.v && r.v.people[0].role === 'owner', 'owner listed first', r.v && r.v.people.map(p => p.role));
for (const [sql, name] of [
  [`select api_invite_save('o2@test.sk', 'O2', 'owner')`, 'invite owner'],
  [`select api_person_update('${owner.id}', null, 'member', null)`, 'demote owner'],
  [`select api_person_update('${owner.id}', null, null, false)`, 'disable owner'],
  [`select api_person_update('${owner.id}', 'Nové meno', null, null)`, 'rename owner'],
  [`select api_person_update('${worker.id}', null, 'owner', null)`, 'make owner'],
  [`select api_person_password('${owner.id}', 'hacked1')`, 'owner password'],
  [`select api_person_delete('${owner.id}')`, 'delete owner']]) {
  r = await q(sql);
  ok(r.err && /^ROLE: /.test(r.err), 'admin blocked: ' + name, r);
}
r = await q(`select api_person_update('${admin.id}', null, null, false)`);
ok(r.err && /Seba vypnúť/.test(r.err), 'admin cannot disable self', r);
r = await q(`select api_person_delete('${admin.id}')`);
ok(r.err && /Seba zmazať/.test(r.err), 'admin cannot delete self', r);
r = await q(`select api_person_password('${worker.id}', 'nove123')`);
ok(r.v && /zmenené/.test(r.v.msg), 'admin resets member password', r);
const pw = (await db.query(`select encrypted_password = extensions.crypt('nove123', encrypted_password) m from auth.users where id = $1`, [worker.id])).rows[0].m;
ok(pw === true, 'new password verifies with bcrypt', pw);
r = await q(`select api_person_password('${worker.id}', '123')`);
ok(r.err && /6 znakov/.test(r.err), 'short password rejected', r);
r = await q(`select api_items_save($1::bigint, $2::jsonb)`, [sheetId, JSON.stringify([
  { op: 'update', id: it1, fields: { real: 10 }, old_real: 0 },            // бачив 0, а в базі 3 → конфлікт
  { op: 'update', id: it2, fields: { name: 'Item 2b', real: 7 }, old_real: 0 },
  { op: 'insert', tmp: 'new_1', fields: { plu: '003', name: 'Item 3', plan: '2' } },
  { op: 'insert', tmp: 'new_2', fields: { plu: '001', name: 'Dup' } }])]);
ok(r.v && r.v.updated === 2 && r.v.inserted === 1 && r.v.conflicts.length === 1 && r.v.errors.length === 1, 'admin items_save with conflict & dup', r);
const real1 = (await db.query(`select real from items where id = $1`, [it1])).rows[0].real;
ok(real1 === 3, 'conflicting real NOT overwritten', real1);
r = await q(`select api_items_save($1::bigint, $2::jsonb)`, [sheetId, JSON.stringify([{ op: 'delete', id: it2 }])]);
ok(r.v && r.v.deleted === 1, 'admin deletes row', r);
r = await q(`select api_backup_list()`);
ok(r.v && r.v.list.some(b => b.reason === 'PRED ZMAZANÍM V TABUĽKE'), 'backup before delete', r.v && r.v.list.map(b => b.reason));

// ---------------------------------------------------------- вимкнений працівник
r = await q(`select api_person_update('${worker.id}', null, null, false)`);
ok(r.v, 'admin disables member', r);
await as(worker.id);
r = await q(`select api_scan('op_test_0003', $1::bigint, 1, 'scan', '')`, [it1]);
ok(r.err && /^AUTH: Váš prístup je vypnutý/.test(r.err), 'disabled member blocked with AUTH', r);
await as(admin.id);
await q(`select api_person_update('${worker.id}', null, null, true)`);
await as(worker.id);
r = await q(`select api_init()`);
ok(r.v && r.v.me, 'member re-enabled works', r);

// ---------------------------------------------------------- власник: останній власник
await as(owner.id);
r = await q(`select api_person_update('${owner.id}', null, 'admin', null)`);
ok(r.err && /aspoň jeden vlastník/.test(r.err), 'last owner cannot demote self', r);
r = await q(`select api_person_update('${admin.id}', null, 'owner', null)`);
ok(r.v, 'owner makes admin an owner', r);
r = await q(`select api_person_update('${owner.id}', null, 'admin', null)`);
ok(r.v, 'owner can step down when another owner exists', r);
await as(admin.id);   // тепер він owner
r = await q(`select api_person_delete('${owner.id}')`);
ok(r.v && /odstránený/.test(r.v.msg), 'new owner deletes former owner', r);
const gone = (await db.query(`select count(*)::int c from auth.users where id = $1`, [owner.id])).rows[0].c;
ok(gone === 0, 'login removed from auth.users', gone);
r = await q(`select api_person_update('${admin.id}', null, 'member', null)`);
ok(r.err && /aspoň jeden vlastník/.test(r.err), 'sole owner protected again', r);

// ---------------------------------------------------------- «сирота» (зареєструвались до міграції)
await db.exec(`alter table auth.users disable trigger on_auth_user_created`);
const orphan = (await db.query(`insert into auth.users(email) values ('orphan@test.sk') returning id`)).rows[0].id;
await db.exec(`alter table auth.users enable trigger on_auth_user_created`);
r = await q(`select api_invite_save('orphan@test.sk', 'Sirota', 'member')`);
ok(r.v && r.v.linked === true && r.v.id === orphan, 'orphan account linked directly', r);
await as(null);
await db.exec(`alter table auth.users disable trigger on_auth_user_created`);
const orphan2 = (await db.query(`insert into auth.users(email) values ('boss@test.sk') returning id`)).rows[0].id;
await db.exec(`alter table auth.users enable trigger on_auth_user_created`);
r = await q(`select invite_owner('boss@test.sk', 'Boss')`);
ok(r.v && /je teraz vlastník/.test(r.v), 'invite_owner rescues orphan', r);
const bossRole = (await db.query(`select role from profiles where id = $1`, [orphan2])).rows[0].role;
ok(bossRole === 'owner', 'orphan became owner', bossRole);

// ---------------------------------------------------------- журнал
await as(admin.id);
r = await q(`select api_logs_all()`);
const acts = r.v.data.map(a => a[7]);
ok(acts.includes('ÚČET') && acts.includes('SKEN') && acts.includes('ÚPRAVA'), 'logs_all has account + scan + edit', [...new Set(acts)]);
r = await q(`select api_logs_clear()`);
ok(r.v && /vymazané/.test(r.v.msg), 'logs clear', r);
r = await q(`select api_logs_all()`);
ok(r.v.data.length === 1 && r.v.data[0][7] === 'CLEAR' && r.v.data[0][8] === 'Adam Admin', 'clear leaves who-cleared record', r.v.data);

console.log((withOld ? '[001→002→003] ' : '[001→003] ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
