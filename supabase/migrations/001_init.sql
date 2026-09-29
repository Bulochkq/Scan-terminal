-- =====================================================================
-- Skladový terminál — схема бази Supabase (Postgres)        v3.1.0
-- Виконати ОДИН раз: Supabase → SQL Editor → New query → вставити → Run.
--
-- Принцип безпеки:
--   * RLS увімкнено на всіх таблицях і політик НЕМАЄ → з браузера таблиці
--     напряму не читаються і не змінюються.
--   * Уся робота йде через функції api_* (SECURITY DEFINER), яким видано
--     право виконання ролі anon (ключ sb_publishable_…).
--   * Адмін-функції перевіряють PIN; у базі лежить лише його bcrypt-хеш.
--   * Кількість змінюється АТОМАРНО дельтою (+N / -N) з op_id: повтор того
--     самого запиту (обрив мережі, ретрай) не додасть удруге.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------- таблиці

create table if not exists sheets (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists workers (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists items (
  id          bigint generated always as identity primary key,
  sheet_id    bigint not null references sheets(id) on delete cascade,
  brand       text not null default '',
  plu         text not null,              -- ТЕКСТ: нулі на початку зберігаються
  name        text not null default '',
  code        text not null default '',   -- SKU / kód výrobcu
  ean         text not null default '',
  plan        integer not null default 0,
  real        integer not null default 0 check (real >= 0),
  note        text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  text not null default '',
  unique (sheet_id, plu)
);
create index if not exists items_sheet_idx    on items (sheet_id);
create index if not exists items_ean_idx      on items (sheet_id, ean);
create index if not exists items_code_idx     on items (sheet_id, code);
create index if not exists items_updated_idx  on items (sheet_id, updated_at);

create table if not exists log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),   -- час сервера
  client_time  text not null default '',             -- час на пристрої (dd.MM.yyyy HH:mm:ss)
  sheet_id     bigint,
  sheet_name   text not null default '',
  item_id      bigint,
  plu          text not null default '',
  name         text not null default '',
  code         text not null default '',
  ean          text not null default '',
  action       text not null,                        -- SKEN, MANUÁL, POZNÁMKA, ADMIN_EDIT, ...
  old_val      text not null default '',
  new_val      text not null default '',
  worker       text not null default ''
);
create index if not exists log_sheet_idx on log (sheet_id, id desc);

-- Ідемпотентність: оброблені op_id (повтор повертає збережений результат)
create table if not exists ops (
  op_id   text primary key,
  at      timestamptz not null default now(),
  result  jsonb not null
);

-- Бекапи складу перед імпортом / видаленням (знімок у JSON)
create table if not exists backups (
  id          bigint generated always as identity primary key,
  sheet_id    bigint,
  sheet_name  text not null,
  reason      text not null,
  row_count   integer not null,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

create table if not exists settings (
  key    text primary key,
  value  text not null
);

alter table sheets   enable row level security;
alter table workers  enable row level security;
alter table items    enable row level security;
alter table log      enable row level security;
alter table ops      enable row level security;
alter table backups  enable row level security;
alter table settings enable row level security;

-- ------------------------------------------------------------- PIN

-- Задати/змінити PIN — ТІЛЬКИ з SQL Editor (anon цю функцію не бачить):
--   select set_admin_pin('ваш-пін');
create or replace function set_admin_pin(p_pin text) returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if length(coalesce(trim(p_pin), '')) < 4 then raise exception 'PIN musí mať aspoň 4 znaky.'; end if;
  insert into settings(key, value) values ('admin_pin_hash', crypt(trim(p_pin), gen_salt('bf')))
  on conflict (key) do update set value = excluded.value;
  return 'PIN uložený.';
end $$;

create or replace function check_pin_(p_pin text) returns boolean
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select exists (select 1 from settings
                 where key = 'admin_pin_hash' and value = crypt(coalesce(trim(p_pin), ''), value));
$$;

create or replace function require_pin_(p_pin text) returns void
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
begin
  if not check_pin_(p_pin) then raise exception 'AUTH: Nesprávne admin heslo.'; end if;
end $$;

-- ------------------------------------------------------------- читання

create or replace function api_init() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'sheets', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'name', name) order by name) from sheets), '[]'::jsonb),
    'users',  coalesce((select jsonb_agg(name order by name) from workers), '[]'::jsonb),
    'pinIsDefault', not exists (select 1 from settings where key = 'admin_pin_hash'),
    'serverTime', (extract(epoch from now()) * 1000)::bigint
  );
$$;

-- Увесь склад одним викликом; рядки масивами (компактно), порядок полів у cols.
create or replace function api_items(p_sheet_id bigint) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'cols', jsonb_build_array('id','brand','plu','name','code','ean','plan','real','note'),
    'data', coalesce((select jsonb_agg(jsonb_build_array(id, brand, plu, name, code, ean, plan, real, note) order by id)
                      from items where sheet_id = p_sheet_id), '[]'::jsonb),
    'sheetName', (select name from sheets where id = p_sheet_id),
    'serverTime', (extract(epoch from now()) * 1000)::bigint
  );
$$;

-- Зміни з моменту p_since (мс) — для синхронізації між пристроями.
create or replace function api_changes(p_sheet_id bigint, p_since bigint) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'changes', coalesce((select jsonb_agg(jsonb_build_array(id, real, note, plan, name, plu, ean, code, brand))
                         from items where sheet_id = p_sheet_id
                           and updated_at > to_timestamp(p_since / 1000.0) - interval '2 seconds'), '[]'::jsonb),
    'count', (select count(*) from items where sheet_id = p_sheet_id),
    'serverTime', (extract(epoch from now()) * 1000)::bigint
  );
$$;

create or replace function api_logs(p_sheet_id bigint, p_limit int default 200) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('logs', coalesce((
    select jsonb_agg(jsonb_build_object(
      'time', coalesce(nullif(client_time, ''), to_char(at at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI:SS')),
      'plu', plu, 'mpn', code, 'ean', ean, 'name', name, 'action', action,
      'user', worker, 'oldVal', old_val, 'newVal', new_val) order by id desc)
    from (select * from log where sheet_id = p_sheet_id order by id desc limit least(greatest(p_limit, 1), 1000)) t
  ), '[]'::jsonb));
$$;

create or replace function api_auth(p_pin text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('valid', check_pin_(p_pin));
$$;

-- ------------------------------------------------------------- сканування

-- Атомарна зміна кількості на p_delta. p_op_id — унікальний id операції з
-- пристрою: повторний виклик з тим самим id нічого не змінює і повертає
-- той самий результат (захист від подвійного запису при ретраях).
create or replace function api_scan(p_op_id text, p_item_id bigint, p_delta integer,
                                    p_worker text, p_type text default 'scan',
                                    p_client_time text default '')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev jsonb; v_old integer; v_new integer; it items%rowtype; v_res jsonb;
begin
  if p_op_id is null or length(p_op_id) < 8 then raise exception 'Chýba op_id.'; end if;
  select result into v_prev from ops where op_id = p_op_id;
  if found then return v_prev || jsonb_build_object('duplicate', true); end if;

  select * into it from items where id = p_item_id for update;
  if not found then raise exception 'ITEM_NOT_FOUND: Položka neexistuje, obnovte dáta.'; end if;

  v_old := it.real;
  v_new := greatest(0, it.real + coalesce(p_delta, 0));
  update items set real = v_new, updated_at = now(), updated_by = coalesce(p_worker, '')
   where id = it.id;

  insert into log(client_time, sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
  values (coalesce(p_client_time, ''), it.sheet_id, (select name from sheets where id = it.sheet_id), it.id,
          it.plu, it.name, it.code, it.ean, case when p_type = 'scan' then 'SKEN' else 'MANUÁL' end,
          v_old::text, v_new::text, coalesce(p_worker, ''));

  v_res := jsonb_build_object('id', it.id, 'oldReal', v_old, 'newReal', v_new,
                              'serverTime', (extract(epoch from now()) * 1000)::bigint);
  insert into ops(op_id, result) values (p_op_id, v_res);
  return v_res;
end $$;

create or replace function api_note(p_item_id bigint, p_note text, p_worker text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare it items%rowtype; v_note text;
begin
  select * into it from items where id = p_item_id for update;
  if not found then raise exception 'ITEM_NOT_FOUND: Položka neexistuje, obnovte dáta.'; end if;
  v_note := case when trim(coalesce(p_note, '')) = '' then ''
                 else trim(p_note) end;
  if v_note is distinct from it.note then
    update items set note = v_note, updated_at = now(), updated_by = coalesce(p_worker, '') where id = it.id;
    insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
    values (it.sheet_id, (select name from sheets where id = it.sheet_id), it.id, it.plu, it.name, it.code, it.ean,
            'POZNÁMKA', it.note, v_note, coalesce(p_worker, ''));
  end if;
  return jsonb_build_object('note', v_note);
end $$;

-- ------------------------------------------------------------- працівники

create or replace function api_user_add(p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if trim(coalesce(p_name, '')) <> '' then
    insert into workers(name) values (trim(p_name)) on conflict (name) do nothing;
  end if;
  return jsonb_build_object('users', coalesce((select jsonb_agg(name order by name) from workers), '[]'::jsonb));
end $$;

create or replace function api_user_del(p_pin text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_pin_(p_pin);
  delete from workers where name = trim(coalesce(p_name, ''));
  return jsonb_build_object('users', coalesce((select jsonb_agg(name order by name) from workers), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------- склади

create or replace function backup_sheet_(p_sheet_id bigint, p_reason text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text; v_cnt int; v_data jsonb;
begin
  select name into v_name from sheets where id = p_sheet_id;
  select count(*), coalesce(jsonb_agg(to_jsonb(i) - 'sheet_id' order by id), '[]'::jsonb)
    into v_cnt, v_data from items i where sheet_id = p_sheet_id;
  if v_cnt = 0 then return ''; end if;
  insert into backups(sheet_id, sheet_name, reason, row_count, data)
  values (p_sheet_id, v_name, p_reason, v_cnt, v_data);
  return v_name || ' (' || to_char(now() at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI') || ', ' || v_cnt || ' r.)';
end $$;

create or replace function api_sheet_create(p_pin text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  perform require_pin_(p_pin);
  if trim(coalesce(p_name, '')) = '' then raise exception 'Zadajte názov skladu.'; end if;
  insert into sheets(name) values (trim(p_name)) returning id into v_id;
  return jsonb_build_object('id', v_id::text, 'msg', 'Sklad «' || trim(p_name) || '» vytvorený.');
exception when unique_violation then
  raise exception 'Sklad s týmto názvom už existuje.';
end $$;

create or replace function api_sheet_delete(p_pin text, p_sheet_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_backup text; v_name text;
begin
  perform require_pin_(p_pin);
  select name into v_name from sheets where id = p_sheet_id;
  if v_name is null then raise exception 'Sklad nenájdený.'; end if;
  v_backup := backup_sheet_(p_sheet_id, 'DELETE');
  delete from sheets where id = p_sheet_id;
  insert into log(sheet_name, action, name, worker) values (v_name, 'DELETE', 'Zmazaný sklad: ' || v_name, 'Admin');
  return jsonb_build_object('msg', 'Sklad zmazaný. Záloha: ' || coalesce(nullif(v_backup, ''), 'nebola potrebná'));
end $$;

-- ------------------------------------------------------------- позиції (адмін)

-- Створити або змінити позицію. p_item: {id?, brand, plu, name, code, ean, plan, real?, note?}
-- Realita змінюється ЛИШЕ якщо ключ real присутній (редактор надсилає його
-- тільки коли людина справді змінила кількість) — так адмін-правка назви
-- не перетирає те, що в цей момент сканують інші.
create or replace function api_item_save(p_pin text, p_sheet_id bigint, p_item jsonb, p_worker text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare it items%rowtype; v_id bigint; v_plu text;
begin
  perform require_pin_(p_pin);
  v_plu := trim(coalesce(p_item->>'plu', ''));
  if v_plu = '' then raise exception 'PLU je povinné.'; end if;

  if p_item ? 'id' and nullif(p_item->>'id', '') is not null then
    select * into it from items where id = (p_item->>'id')::bigint and sheet_id = p_sheet_id for update;
    if not found then raise exception 'ITEM_NOT_FOUND: Položka neexistuje, obnovte dáta.'; end if;
    update items set
      brand = coalesce(p_item->>'brand', brand), plu = v_plu,
      name  = coalesce(p_item->>'name', name),   code = coalesce(p_item->>'code', code),
      ean   = coalesce(p_item->>'ean', ean),
      plan  = coalesce((p_item->>'plan')::int, plan),
      real  = case when p_item ? 'real' then greatest(0, (p_item->>'real')::int) else real end,
      note  = coalesce(p_item->>'note', note),
      updated_at = now(), updated_by = coalesce(p_worker, '')
    where id = it.id;
    insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
    values (p_sheet_id, (select name from sheets where id = p_sheet_id), it.id, v_plu,
            coalesce(p_item->>'name', it.name), coalesce(p_item->>'code', it.code), coalesce(p_item->>'ean', it.ean),
            'ADMIN_EDIT', it.real::text,
            (case when p_item ? 'real' then greatest(0, (p_item->>'real')::int) else it.real end)::text,
            coalesce(p_worker, ''));
    v_id := it.id;
  else
    insert into items(sheet_id, brand, plu, name, code, ean, plan, real, note, updated_by)
    values (p_sheet_id, coalesce(p_item->>'brand', ''), v_plu, coalesce(p_item->>'name', ''),
            coalesce(p_item->>'code', ''), coalesce(p_item->>'ean', ''),
            coalesce((p_item->>'plan')::int, 0), greatest(0, coalesce((p_item->>'real')::int, 0)),
            coalesce(p_item->>'note', ''), coalesce(p_worker, ''))
    returning id into v_id;
    insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
    values (p_sheet_id, (select name from sheets where id = p_sheet_id), v_id, v_plu,
            coalesce(p_item->>'name', ''), coalesce(p_item->>'code', ''), coalesce(p_item->>'ean', ''),
            'ADMIN_ADD', '0', coalesce(p_item->>'real', '0'), coalesce(p_worker, ''));
  end if;
  return jsonb_build_object('id', v_id, 'msg', 'Uložené.');
exception when unique_violation then
  raise exception 'Položka s PLU % už v sklade existuje.', v_plu;
end $$;

create or replace function api_item_delete(p_pin text, p_item_id bigint, p_worker text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare it items%rowtype;
begin
  perform require_pin_(p_pin);
  delete from items where id = p_item_id returning * into it;
  if not found then raise exception 'ITEM_NOT_FOUND: Položka už neexistuje.'; end if;
  insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
  values (it.sheet_id, (select name from sheets where id = it.sheet_id), it.id, it.plu, it.name, it.code, it.ean,
          'ADMIN_DEL', it.real::text, '', coalesce(p_worker, ''));
  return jsonb_build_object('msg', 'Zmazané.');
end $$;

-- ------------------------------------------------------------- імпорт

-- Імпорт порціями (клієнт шле по ~2000 рядків, щоб не впертись у таймаут).
-- p_first = true на першій порції: робиться бекап, а в режимі 'replace'
-- склад очищується. Режим 'merge': оновлює план/назви за PLU, ЗБЕРІГАЄ
-- Realita й нотатки і НЕ видаляє позиції, яких нема у файлі.
-- p_rows: [{brand, plu, name, code, ean, plan}, ...]
create or replace function api_import(p_pin text, p_sheet_id bigint, p_rows jsonb,
                                      p_mode text, p_first boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_backup text := ''; v_cnt int;
begin
  perform require_pin_(p_pin);
  if not exists (select 1 from sheets where id = p_sheet_id) then raise exception 'Sklad nenájdený.'; end if;

  if p_first then
    v_backup := backup_sheet_(p_sheet_id, 'IMPORT ' || coalesce(p_mode, 'replace'));
    if coalesce(p_mode, 'replace') = 'replace' then
      delete from items where sheet_id = p_sheet_id;
    end if;
  end if;

  with src as (
    select distinct on (trim(r->>'plu'))
           trim(coalesce(r->>'brand', '')) as brand, trim(r->>'plu') as plu,
           trim(coalesce(r->>'name', '')) as name, trim(coalesce(r->>'code', '')) as code,
           trim(coalesce(r->>'ean', '')) as ean, coalesce(floor((r->>'plan')::numeric)::int, 0) as plan
    from jsonb_array_elements(p_rows) r
    where trim(coalesce(r->>'plu', '')) <> ''
  )
  insert into items(sheet_id, brand, plu, name, code, ean, plan, updated_by)
  select p_sheet_id, brand, plu, name, code, ean, plan, 'Import' from src
  on conflict (sheet_id, plu) do update set
    brand = excluded.brand, name = excluded.name, code = excluded.code,
    ean = excluded.ean, plan = excluded.plan, updated_at = now(), updated_by = 'Import';
  get diagnostics v_cnt = row_count;

  return jsonb_build_object('count', v_cnt, 'backup', v_backup);
end $$;

create or replace function api_import_done(p_pin text, p_sheet_id bigint, p_total int, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now int;
begin
  perform require_pin_(p_pin);
  select count(*) into v_now from items where sheet_id = p_sheet_id;
  insert into log(sheet_id, sheet_name, action, name, old_val, new_val, worker)
  values (p_sheet_id, (select name from sheets where id = p_sheet_id), 'IMPORT',
          'Import ' || p_total || ' položiek (' || coalesce(p_mode, 'replace') || ')', '', v_now::text, 'Admin');
  return jsonb_build_object('msg', 'Import hotový: ' || p_total || ' položiek zo súboru, v sklade teraz ' || v_now || '.', 'count', v_now);
end $$;

-- ------------------------------------------------------------- бекапи і логи

create or replace function api_backup_list(p_pin text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform require_pin_(p_pin);
  return jsonb_build_object('list', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id::text, 'rows', row_count, 'reason', reason,
      'name', sheet_name || '_BACKUP_' || to_char(created_at at time zone 'Europe/Bratislava', 'YYYYMMDD_HH24MISS'))
      order by created_at desc) from backups), '[]'::jsonb));
end $$;

create or replace function api_backup_delete(p_pin text, p_backup_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_pin_(p_pin);
  delete from backups where id = p_backup_id;
  return jsonb_build_object('msg', 'Záloha zmazaná.');
end $$;

-- Відновити склад з бекапу: поточний стан спершу теж бекапиться.
create or replace function api_backup_restore(p_pin text, p_backup_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b backups%rowtype; v_sheet bigint;
begin
  perform require_pin_(p_pin);
  select * into b from backups where id = p_backup_id;
  if not found then raise exception 'Záloha nenájdená.'; end if;
  select id into v_sheet from sheets where name = b.sheet_name;
  if v_sheet is null then insert into sheets(name) values (b.sheet_name) returning id into v_sheet;
  else perform backup_sheet_(v_sheet, 'PRED OBNOVENÍM'); delete from items where sheet_id = v_sheet; end if;
  insert into items(sheet_id, brand, plu, name, code, ean, plan, real, note, updated_by)
  select v_sheet, coalesce(r->>'brand',''), r->>'plu', coalesce(r->>'name',''), coalesce(r->>'code',''),
         coalesce(r->>'ean',''), coalesce((r->>'plan')::int,0), coalesce((r->>'real')::int,0),
         coalesce(r->>'note',''), 'Obnova'
  from jsonb_array_elements(b.data) r;
  insert into log(sheet_id, sheet_name, action, name, worker)
  values (v_sheet, b.sheet_name, 'IMPORT', 'Obnovené zo zálohy (' || b.row_count || ' r.)', 'Admin');
  return jsonb_build_object('msg', 'Sklad «' || b.sheet_name || '» obnovený (' || b.row_count || ' položiek).');
end $$;

create or replace function api_logs_clear(p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v int;
begin
  perform require_pin_(p_pin);
  delete from log; get diagnostics v = row_count;
  delete from ops where at < now() - interval '2 days';
  return jsonb_build_object('msg', 'Logy vymazané (' || v || ' záznamov).');
end $$;

-- ------------------------------------------------------------- права

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function
  api_init(), api_items(bigint), api_changes(bigint, bigint), api_logs(bigint, int), api_auth(text),
  api_scan(text, bigint, integer, text, text, text), api_note(bigint, text, text),
  api_user_add(text), api_user_del(text, text),
  api_sheet_create(text, text), api_sheet_delete(text, bigint),
  api_item_save(text, bigint, jsonb, text), api_item_delete(text, bigint, text),
  api_import(text, bigint, jsonb, text, boolean), api_import_done(text, bigint, int, text),
  api_backup_list(text), api_backup_delete(text, bigint), api_backup_restore(text, bigint),
  api_logs_clear(text)
to anon, authenticated;

-- Імпорт великого складу: дати функціям більше часу, ніж типові 3 с для anon.
alter function api_import(text, bigint, jsonb, text, boolean) set statement_timeout = '60s';
alter function api_backup_restore(text, bigint)               set statement_timeout = '60s';
alter function api_sheet_delete(text, bigint)                 set statement_timeout = '60s';

-- Первинні дані
insert into workers(name) values ('Skladník 1') on conflict do nothing;
