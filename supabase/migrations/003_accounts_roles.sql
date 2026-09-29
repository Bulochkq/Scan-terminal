-- =====================================================================
-- Skladový terminál — ВХІД ЗА E-MAILОМ І ПАРОЛЕМ + РОЛІ            v3.1.3
--
-- ЯК ВИКОНАТИ:
--   Supabase → проект sklad-terminal → SQL Editor → New query →
--   вставити ВЕСЬ цей файл → Run. Повторний запуск нічого не псує.
--
--   Файл 002 запускати НЕ треба: усе з нього (збереження з таблиці,
--   журнал усіх складів) є тут, уже з ролями замість PIN.
--
-- ПЕРЕД ЦИМ (одна хвилина, у панелі Supabase):
--   Authentication → Sign In / Providers → Email → «Confirm email» ВИМКНУТИ.
--   Інакше кожен новий акаунт чекав би на лист із підтвердженням, а листи
--   на безкоштовному тарифі — кілька на годину. «Allow new users to sign up»
--   лишається УВІМКНЕНИМ: без запрошення зареєструватись однаково не вийде
--   (це перевіряє база, див. handle_new_user нижче).
--
-- ПІСЛЯ ЦЬОГО — одним рядком стати власником (свій e-mail і ім'я):
--   select invite_owner('vas@email.sk', 'Vaše meno');
-- і на сайті натиснути «Prvé prihlásenie» → той самий e-mail → своє heslo.
--
-- ЩО ЗМІНЮЄТЬСЯ:
--   * Спільний адмін-PIN зникає. Кожна людина входить своїм e-mailом і
--     паролем; що їй можна — вирішує роль:
--       owner  (Vlastník)  — усе, зокрема керувати іншими власниками;
--       admin  (Správca)   — усе, крім власників: не змінює, не вимикає й не
--                             видаляє їх і нікого не робить власником;
--       member (Pracovník) — інвентура: скан, ручне +/−, нотатки, перегляд.
--   * Хто сканував, база бере з входу, а не з того, що надіслав браузер —
--     підписатись чужим ім'ям більше не можна.
--   * Анонімний відвідувач (без входу) не може викликати ЖОДНОЇ функції.
--
-- ЧОМУ САМЕ ТАК: така сама схема (profiles + invites, ролі owner/admin/member,
-- вхід Supabase Auth) уже працює в Flex Bike Analytics. Коли проекти колись
-- об'єднаються, акаунти зіллються за e-mailом без переробок.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------- люди

-- Логін і пароль Supabase тримає сам (auth.users) — пароля не бачимо навіть
-- ми. Тут лише те, що стосується програми: ім'я і що людині можна.
-- is_active — вимикач: звільненого не видаляємо (зник би підпис під його
-- сканами в журналі), а вимикаємо.
create table if not exists profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Запрошення: зареєструватись може лише той, чий e-mail сюди вписав
-- власник або správca. Листи нікуди не надсилаються.
create table if not exists invites (
  email       text primary key,                       -- завжди малими літерами
  full_name   text not null default '',
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid,
  used_at     timestamptz
);

alter table profiles enable row level security;
alter table invites  enable row level security;

-- Хто зробив запис у журналі — надійно, за акаунтом (ім'я лишається текстом:
-- після видалення людини підпис у журналі не зникає).
alter table log add column if not exists user_id uuid;

-- ------------------------------------------------------------- прибрати старе

drop function if exists api_migrate_tmp(text, text, jsonb, boolean);
drop function if exists api_auth(text);
drop function if exists api_scan(text, bigint, integer, text, text, text);
drop function if exists api_note(bigint, text, text);
drop function if exists api_user_add(text);
drop function if exists api_user_del(text, text);
drop function if exists api_sheet_create(text, text);
drop function if exists api_sheet_delete(text, bigint);
drop function if exists api_item_save(text, bigint, jsonb, text);
drop function if exists api_item_delete(text, bigint, text);
drop function if exists api_import(text, bigint, jsonb, text, boolean);
drop function if exists api_import_done(text, bigint, int, text);
drop function if exists api_backup_list(text);
drop function if exists api_backup_delete(text, bigint);
drop function if exists api_backup_restore(text, bigint);
drop function if exists api_logs_clear(text);
drop function if exists api_items_save(text, bigint, jsonb, text);
drop function if exists api_logs_all(text, bigint, int);
drop function if exists set_admin_pin(text);
drop function if exists require_pin_(text);
drop function if exists check_pin_(text);
delete from settings where key = 'admin_pin_hash';

-- ------------------------------------------------------------- хто питає

-- Ранг ролі: керувати можна рівнем не вищим за свій.
create or replace function role_rank_(p_role text) returns int
language sql immutable as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 else 0 end;
$$;

-- Профіль того, хто викликав функцію. Помилки з «AUTH:» фронтенд розуміє як
-- «вхід недійсний» і показує екран входу.
create or replace function me_() returns profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles;
begin
  if auth.uid() is null then raise exception 'AUTH: Nie ste prihlásený.'; end if;
  select * into p from profiles where id = auth.uid();
  if not found then raise exception 'AUTH: Váš účet v programe neexistuje. Obráťte sa na správcu.'; end if;
  if not p.is_active then raise exception 'AUTH: Váš prístup je vypnutý. Obráťte sa na správcu.'; end if;
  return p;
end $$;

-- Те саме + перевірка ролі. «ROLE:» = «увійшов, але цього не можна» (без виходу).
create or replace function require_role_(p_min text) returns profiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles;
begin
  p := me_();
  if role_rank_(p.role) < role_rank_(p_min) then
    raise exception 'ROLE: Na túto akciu nemáte oprávnenie.';
  end if;
  return p;
end $$;

-- Підпис у журналі: ім'я, а якщо його немає — e-mail.
create or replace function who_(p profiles) returns text
language sql immutable as $$
  select coalesce(nullif(trim(p.full_name), ''), p.email);
$$;

-- Скільки ще АКТИВНИХ власників, крім указаного. Програма не має лишитись без
-- власника — тоді нікому було б навіть повернути права (лише через SQL).
create or replace function other_owners_(p_except uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from profiles where role = 'owner' and is_active and id <> p_except;
$$;

-- ------------------------------------------------------------- реєстрація

-- Спрацьовує, коли Supabase створює логін. Без запрошення — відмова (Supabase
-- покаже «Database error saving new user», фронтенд перекладе це людською мовою).
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v invites%rowtype;
begin
  select * into v from invites where email = lower(new.email) and used_at is null;
  if not found then
    raise exception 'Tento e-mail nemá pozvánku. Požiadajte správcu, aby vás pridal.' using errcode = '42501';
  end if;
  update invites set used_at = now() where email = v.email;
  insert into profiles (id, email, full_name, role)
  values (new.id, lower(new.email),
          coalesce(nullif(trim(v.full_name), ''), nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
                   split_part(new.email, '@', 1)),
          v.role)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Стати власником (або повернути собі права) — ЛИШЕ з SQL Editor:
--   select invite_owner('vas@email.sk', 'Vaše meno');
-- Браузер цю функцію не бачить (права нижче).
create or replace function invite_owner(p_email text, p_name text default '') returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Neplatný e-mail: %', p_email; end if;
  update profiles set role = 'owner', is_active = true, updated_at = now() where email = v_email;
  if found then return 'Účet ' || v_email || ' je teraz vlastník.'; end if;
  -- логін уже є, а профілю нема (зареєструвались ДО цієї міграції) —
  -- без цього людина застрягла б: «уже зареєстровані», але в програму не пускає
  insert into profiles (id, email, full_name, role)
  select u.id, v_email, coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)), 'owner'
    from auth.users u where lower(u.email) = v_email
  on conflict (id) do update set role = 'owner', is_active = true, updated_at = now();
  if found then return 'Účet ' || v_email || ' je teraz vlastník — prihláste sa svojím heslom.'; end if;
  insert into invites (email, full_name, role) values (v_email, trim(coalesce(p_name, '')), 'owner')
  on conflict (email) do update set role = 'owner', full_name = excluded.full_name, used_at = null, created_at = now();
  return 'Pozvánka pre vlastníka ' || v_email || ' je pripravená. Na stránke kliknite «Prvé prihlásenie».';
end $$;

-- ------------------------------------------------------------- читання (усі, хто увійшов)

create or replace function api_init() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles;
begin
  p := me_();
  return jsonb_build_object(
    'sheets', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'name', name) order by name) from sheets), '[]'::jsonb),
    'me', jsonb_build_object('id', p.id, 'email', p.email, 'name', who_(p), 'role', p.role),
    'serverTime', (extract(epoch from now()) * 1000)::bigint
  );
end $$;

-- Увесь склад одним викликом; рядки масивами (компактно), порядок полів у cols.
create or replace function api_items(p_sheet_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform me_();
  return jsonb_build_object(
    'cols', jsonb_build_array('id','brand','plu','name','code','ean','plan','real','note'),
    'data', coalesce((select jsonb_agg(jsonb_build_array(id, brand, plu, name, code, ean, plan, real, note) order by id)
                      from items where sheet_id = p_sheet_id), '[]'::jsonb),
    'sheetName', (select name from sheets where id = p_sheet_id),
    'serverTime', (extract(epoch from now()) * 1000)::bigint
  );
end $$;

-- Зміни з моменту p_since (мс) — для синхронізації між пристроями.
create or replace function api_changes(p_sheet_id bigint, p_since bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform me_();
  return jsonb_build_object(
    'changes', coalesce((select jsonb_agg(jsonb_build_array(id, real, note, plan, name, plu, ean, code, brand))
                         from items where sheet_id = p_sheet_id
                           and updated_at > to_timestamp(p_since / 1000.0) - interval '2 seconds'), '[]'::jsonb),
    'count', (select count(*) from items where sheet_id = p_sheet_id),
    'serverTime', (extract(epoch from now()) * 1000)::bigint
  );
end $$;

create or replace function api_logs(p_sheet_id bigint, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform me_();
  return jsonb_build_object('logs', coalesce((
    select jsonb_agg(jsonb_build_object(
      'time', coalesce(nullif(client_time, ''), to_char(at at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI:SS')),
      'plu', plu, 'mpn', code, 'ean', ean, 'name', name, 'action', action,
      'user', worker, 'oldVal', old_val, 'newVal', new_val) order by id desc)
    from (select * from log where sheet_id = p_sheet_id order by id desc limit least(greatest(p_limit, 1), 1000)) t
  ), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------- інвентура (усі, хто увійшов)

-- Атомарна зміна кількості на p_delta. p_op_id — унікальний id операції з
-- пристрою: повторний виклик з тим самим id нічого не змінює і повертає
-- той самий результат (захист від подвійного запису при ретраях).
-- v3.1.3: p_worker прибрано — хто сканував, база знає з входу.
create or replace function api_scan(p_op_id text, p_item_id bigint, p_delta integer,
                                    p_type text default 'scan', p_client_time text default '')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me profiles; v_prev jsonb; v_old integer; v_new integer; it items%rowtype; v_res jsonb;
begin
  me := me_();
  if p_op_id is null or length(p_op_id) < 8 then raise exception 'Chýba op_id.'; end if;
  select result into v_prev from ops where op_id = p_op_id;
  if found then return v_prev || jsonb_build_object('duplicate', true); end if;

  select * into it from items where id = p_item_id for update;
  if not found then raise exception 'ITEM_NOT_FOUND: Položka neexistuje, obnovte dáta.'; end if;

  v_old := it.real;
  v_new := greatest(0, it.real + coalesce(p_delta, 0));
  update items set real = v_new, updated_at = now(), updated_by = who_(me) where id = it.id;

  insert into log(client_time, sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker, user_id)
  values (coalesce(p_client_time, ''), it.sheet_id, (select name from sheets where id = it.sheet_id), it.id,
          it.plu, it.name, it.code, it.ean, case when p_type = 'scan' then 'SKEN' else 'MANUÁL' end,
          v_old::text, v_new::text, who_(me), me.id);

  v_res := jsonb_build_object('id', it.id, 'oldReal', v_old, 'newReal', v_new,
                              'serverTime', (extract(epoch from now()) * 1000)::bigint);
  insert into ops(op_id, result) values (p_op_id, v_res);
  return v_res;
end $$;

create or replace function api_note(p_item_id bigint, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; it items%rowtype; v_note text;
begin
  me := me_();
  select * into it from items where id = p_item_id for update;
  if not found then raise exception 'ITEM_NOT_FOUND: Položka neexistuje, obnovte dáta.'; end if;
  v_note := trim(coalesce(p_note, ''));
  if v_note is distinct from it.note then
    update items set note = v_note, updated_at = now(), updated_by = who_(me) where id = it.id;
    insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker, user_id)
    values (it.sheet_id, (select name from sheets where id = it.sheet_id), it.id, it.plu, it.name, it.code, it.ean,
            'POZNÁMKA', it.note, v_note, who_(me), me.id);
  end if;
  return jsonb_build_object('note', v_note);
end $$;

-- ------------------------------------------------------------- склади (Správca+)

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

create or replace function api_sheet_create(p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v_id bigint;
begin
  me := require_role_('admin');
  if trim(coalesce(p_name, '')) = '' then raise exception 'Zadajte názov skladu.'; end if;
  insert into sheets(name) values (trim(p_name)) returning id into v_id;
  return jsonb_build_object('id', v_id::text, 'msg', 'Sklad «' || trim(p_name) || '» vytvorený.');
exception when unique_violation then
  raise exception 'Sklad s týmto názvom už existuje.';
end $$;

create or replace function api_sheet_delete(p_sheet_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v_backup text; v_name text;
begin
  me := require_role_('admin');
  select name into v_name from sheets where id = p_sheet_id;
  if v_name is null then raise exception 'Sklad nenájdený.'; end if;
  v_backup := backup_sheet_(p_sheet_id, 'DELETE');
  delete from sheets where id = p_sheet_id;
  insert into log(sheet_name, action, name, worker, user_id) values (v_name, 'DELETE', 'Zmazaný sklad: ' || v_name, who_(me), me.id);
  return jsonb_build_object('msg', 'Sklad zmazaný. Záloha: ' || coalesce(nullif(v_backup, ''), 'nebola potrebná'));
end $$;

-- ------------------------------------------------------------- таблиця складу (Správca+)

create or replace function int_or_(p text, p_default int) returns int
language sql immutable as $$
  select case when nullif(trim(coalesce(p, '')), '') is null then p_default
              else round(replace(trim(p), ',', '.')::numeric)::int end;
$$;

-- Пачка змін з таблиці. Кожен рядок окремо: помилка в одному (дубль PLU) не
-- скасовує решту. ТОЧНІСТЬ: якщо змінили Realita, клієнт шле й стару, яку
-- бачила людина (old_real). Якщо в базі вже інша (хтось сканував) — Realita
-- НЕ перезаписується, повертається конфлікт; решта полів зберігається.
-- p_changes: [
--   {"op":"update","id":123,"fields":{"name":"…","real":5,…},"old_real":3},
--   {"op":"insert","tmp":"new_1","fields":{"plu":"…","name":"…",…}},
--   {"op":"delete","id":456}
-- ]
create or replace function api_items_save(p_sheet_id bigint, p_changes jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me profiles; v_who text;
  c jsonb; f jsonb; it items%rowtype; v_id bigint; v_sheet_name text;
  v_upd int := 0; v_ins int := 0; v_del int := 0;
  v_conf jsonb := '[]'::jsonb; v_err jsonb := '[]'::jsonb; v_new jsonb := '[]'::jsonb;
  v_real int; v_skip_real boolean; v_plu text;
begin
  me := require_role_('admin');
  v_who := who_(me);
  select name into v_sheet_name from sheets where id = p_sheet_id;
  if v_sheet_name is null then raise exception 'Sklad nenájdený.'; end if;

  -- перед видаленням рядків — знімок складу (відновлюється в «Zálohy»)
  if exists (select 1 from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) x where x->>'op' = 'delete') then
    perform backup_sheet_(p_sheet_id, 'PRED ZMAZANÍM V TABUĽKE');
  end if;

  for c in select value from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    f := coalesce(c->'fields', '{}'::jsonb);
    it := null;
    begin
      if c->>'op' = 'delete' then
        delete from items where id = (c->>'id')::bigint and sheet_id = p_sheet_id returning * into it;
        if found then
          v_del := v_del + 1;
          insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker, user_id)
          values (p_sheet_id, v_sheet_name, it.id, it.plu, it.name, it.code, it.ean,
                  'ADMIN_DEL', it.real::text, '', v_who, me.id);
        end if;

      elsif c->>'op' = 'insert' then
        v_plu := trim(coalesce(f->>'plu', ''));
        if v_plu = '' then raise exception 'PLU je povinné.'; end if;
        insert into items(sheet_id, brand, plu, name, code, ean, plan, real, note, updated_by)
        values (p_sheet_id, trim(coalesce(f->>'brand', '')), v_plu, trim(coalesce(f->>'name', '')),
                trim(coalesce(f->>'code', '')), trim(coalesce(f->>'ean', '')),
                int_or_(f->>'plan', 0), greatest(0, int_or_(f->>'real', 0)),
                coalesce(f->>'note', ''), v_who)
        returning id into v_id;
        v_ins := v_ins + 1;
        v_new := v_new || jsonb_build_array(jsonb_build_object('tmp', c->>'tmp', 'id', v_id));
        insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker, user_id)
        values (p_sheet_id, v_sheet_name, v_id, v_plu, trim(coalesce(f->>'name', '')),
                trim(coalesce(f->>'code', '')), trim(coalesce(f->>'ean', '')),
                'ADMIN_ADD', '0', greatest(0, int_or_(f->>'real', 0))::text, v_who, me.id);

      else
        select * into it from items where id = (c->>'id')::bigint and sheet_id = p_sheet_id for update;
        if not found then raise exception 'Položka už neexistuje (medzitým ju niekto zmazal).'; end if;
        if f ? 'plu' and trim(coalesce(f->>'plu', '')) = '' then raise exception 'PLU je povinné.'; end if;

        v_skip_real := false;
        if f ? 'real' and c ? 'old_real' and int_or_(c->>'old_real', -1) <> it.real then
          v_skip_real := true;
          v_conf := v_conf || jsonb_build_array(jsonb_build_object(
            'id', it.id, 'plu', it.plu, 'name', it.name,
            'yours', greatest(0, int_or_(f->>'real', 0)), 'seen', int_or_(c->>'old_real', 0), 'actual', it.real));
        end if;
        v_real := case when f ? 'real' and not v_skip_real then greatest(0, int_or_(f->>'real', 0)) else it.real end;

        update items set
          brand = case when f ? 'brand' then trim(coalesce(f->>'brand', '')) else brand end,
          plu   = case when f ? 'plu'   then trim(f->>'plu')                   else plu   end,
          name  = case when f ? 'name'  then trim(coalesce(f->>'name', ''))  else name  end,
          code  = case when f ? 'code'  then trim(coalesce(f->>'code', ''))  else code  end,
          ean   = case when f ? 'ean'   then trim(coalesce(f->>'ean', ''))   else ean   end,
          plan  = case when f ? 'plan'  then int_or_(f->>'plan', 0)          else plan  end,
          note  = case when f ? 'note'  then coalesce(f->>'note', '')        else note  end,
          real  = v_real,
          updated_at = now(), updated_by = v_who
        where id = it.id;
        v_upd := v_upd + 1;

        insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker, user_id)
        values (p_sheet_id, v_sheet_name, it.id,
                case when f ? 'plu'  then trim(f->>'plu') else it.plu end,
                case when f ? 'name' then trim(coalesce(f->>'name', '')) else it.name end,
                case when f ? 'code' then trim(coalesce(f->>'code', '')) else it.code end,
                case when f ? 'ean'  then trim(coalesce(f->>'ean', ''))  else it.ean  end,
                'ÚPRAVA', it.real::text, v_real::text, v_who, me.id);
      end if;

    exception
      when unique_violation then
        v_err := v_err || jsonb_build_array(jsonb_build_object(
          'id', c->>'id', 'tmp', c->>'tmp', 'plu', coalesce(f->>'plu', it.plu), 'msg', 'Toto PLU už v sklade existuje.'));
      when others then
        v_err := v_err || jsonb_build_array(jsonb_build_object(
          'id', c->>'id', 'tmp', c->>'tmp', 'plu', coalesce(f->>'plu', it.plu), 'msg', sqlerrm));
    end;
  end loop;

  return jsonb_build_object('updated', v_upd, 'inserted', v_ins, 'deleted', v_del,
                            'conflicts', v_conf, 'errors', v_err, 'newIds', v_new);
end $$;

-- ------------------------------------------------------------- імпорт (Správca+)

-- Імпорт порціями (клієнт шле по ~2000 рядків, щоб не впертись у таймаут).
-- p_first = true на першій порції: бекап, а в режимі 'replace' склад очищується.
-- 'merge': оновлює план/назви за PLU, ЗБЕРІГАЄ Realita й нотатки і НЕ
-- видаляє позиції, яких нема у файлі.
create or replace function api_import(p_sheet_id bigint, p_rows jsonb, p_mode text, p_first boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v_backup text := ''; v_cnt int;
begin
  me := require_role_('admin');
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

create or replace function api_import_done(p_sheet_id bigint, p_total int, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v_now int;
begin
  me := require_role_('admin');
  select count(*) into v_now from items where sheet_id = p_sheet_id;
  insert into log(sheet_id, sheet_name, action, name, old_val, new_val, worker, user_id)
  values (p_sheet_id, (select name from sheets where id = p_sheet_id), 'IMPORT',
          'Import ' || p_total || ' položiek (' || coalesce(p_mode, 'replace') || ')', '', v_now::text, who_(me), me.id);
  return jsonb_build_object('msg', 'Import hotový: ' || p_total || ' položiek zo súboru, v sklade teraz ' || v_now || '.', 'count', v_now);
end $$;

-- ------------------------------------------------------------- бекапи і журнал (Správca+)

create or replace function api_backup_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform require_role_('admin');
  return jsonb_build_object('list', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id::text, 'rows', row_count, 'reason', reason,
      'name', sheet_name || '_BACKUP_' || to_char(created_at at time zone 'Europe/Bratislava', 'YYYYMMDD_HH24MISS'))
      order by created_at desc) from backups), '[]'::jsonb));
end $$;

create or replace function api_backup_delete(p_backup_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_role_('admin');
  delete from backups where id = p_backup_id;
  return jsonb_build_object('msg', 'Záloha zmazaná.');
end $$;

-- Відновити склад з бекапу: поточний стан спершу теж бекапиться.
create or replace function api_backup_restore(p_backup_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; b backups%rowtype; v_sheet bigint;
begin
  me := require_role_('admin');
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
  insert into log(sheet_id, sheet_name, action, name, worker, user_id)
  values (v_sheet, b.sheet_name, 'IMPORT', 'Obnovené zo zálohy (' || b.row_count || ' r.)', who_(me), me.id);
  return jsonb_build_object('msg', 'Sklad «' || b.sheet_name || '» obnovený (' || b.row_count || ' položiek).');
end $$;

-- Журнал у вигляді таблиці (Administrácia → História): усі склади або один.
create or replace function api_logs_all(p_sheet_id bigint default null, p_limit int default 20000)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform require_role_('admin');
  return jsonb_build_object(
    'cols', jsonb_build_array('id', 'time', 'sheet', 'plu', 'name', 'code', 'ean', 'action', 'worker', 'oldVal', 'newVal'),
    'data', coalesce((
      select jsonb_agg(jsonb_build_array(
               id,
               coalesce(nullif(client_time, ''), to_char(at at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI:SS')),
               sheet_name, plu, name, code, ean, action, worker, old_val, new_val) order by id desc)
      from (select * from log
            where p_sheet_id is null or sheet_id = p_sheet_id
            order by id desc
            limit least(greatest(coalesce(p_limit, 20000), 1), 50000)) t
    ), '[]'::jsonb),
    'total', (select count(*) from log where p_sheet_id is null or sheet_id = p_sheet_id)
  );
end $$;

create or replace function api_logs_clear() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v int;
begin
  me := require_role_('admin');
  delete from log; get diagnostics v = row_count;
  delete from ops where at < now() - interval '2 days';
  -- хто стер журнал — перший запис нового журналу
  insert into log(action, name, worker, user_id) values ('CLEAR', 'Vymazaná história (' || v || ' záznamov)', who_(me), me.id);
  return jsonb_build_object('msg', 'Logy vymazané (' || v || ' záznamov).');
end $$;

-- ------------------------------------------------------------- люди (Správca+)
--
-- Правила ті самі, що у Flex Bike Analytics (міграція 018) і в GitHub/Slack:
--   * správca не чіпає власників і нікого не робить власником;
--   * сам себе ніхто не вимикає і не видаляє (замкнувся б зовні);
--   * ОСТАННЬОГО активного власника не можна ні понизити, ні вимкнути, ні видалити.
-- Кожна зміна пишеться в журнал (дія ÚČET) — видно, хто кому що дав.

create or replace function log_account_(me profiles, p_text text, p_old text default '', p_new text default '')
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into log(action, name, old_val, new_val, worker, user_id)
  values ('ÚČET', p_text, coalesce(p_old, ''), coalesce(p_new, ''), who_(me), me.id);
$$;

create or replace function api_people() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me profiles;
begin
  me := require_role_('admin');
  return jsonb_build_object(
    'me', me.id,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'email', p.email, 'name', p.full_name, 'role', p.role, 'active', p.is_active,
               'lastLogin', coalesce(to_char(u.last_sign_in_at at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI'), ''))
             order by role_rank_(p.role) desc, p.is_active desc, lower(p.full_name))
      from profiles p left join auth.users u on u.id = p.id), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
               'email', i.email, 'name', i.full_name, 'role', i.role,
               'created', to_char(i.created_at at time zone 'Europe/Bratislava', 'DD.MM.YYYY'))
             order by i.created_at desc)
      from invites i where i.used_at is null), '[]'::jsonb)
  );
end $$;

-- Пустити нову людину: запрошення на e-mail з роллю. Пароль людина задає сама
-- при першому вході — або його одразу задає správca (фронтенд тоді відразу
-- реєструє акаунт стандартним викликом Supabase).
create or replace function api_invite_save(p_email text, p_name text, p_role text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v_email text := lower(trim(coalesce(p_email, ''))); v_old invites%rowtype; v_uid uuid;
begin
  me := require_role_('admin');
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Zadajte platný e-mail.'; end if;
  if trim(coalesce(p_name, '')) = '' then raise exception 'Zadajte meno.'; end if;
  if p_role not in ('owner', 'admin', 'member') then raise exception 'Neplatná rola.'; end if;
  if me.role <> 'owner' and p_role = 'owner' then raise exception 'ROLE: Vlastníka môže pridať len vlastník.'; end if;
  if exists (select 1 from profiles where email = v_email) then
    raise exception 'Tento e-mail už v programe účet má.';
  end if;
  select * into v_old from invites where email = v_email;
  if found and v_old.role = 'owner' and me.role <> 'owner' then
    raise exception 'ROLE: Pozvánku vlastníka môže meniť len vlastník.';
  end if;

  -- логін у Supabase уже є, а профілю нема — підключаємо одразу, без запрошення
  -- (зареєструватись удруге людина вже не змогла б: «e-mail уже існує»)
  select id into v_uid from auth.users where lower(email) = v_email;
  if v_uid is not null then
    insert into profiles (id, email, full_name, role) values (v_uid, v_email, trim(p_name), p_role)
    on conflict (id) do nothing;
    delete from invites where email = v_email;
    perform log_account_(me, 'Pridaný existujúci účet: ' || trim(p_name) || ' <' || v_email || '>', '', p_role);
    return jsonb_build_object('msg', 'Účet ' || v_email || ' už existoval — prístup je zapnutý.', 'linked', true, 'id', v_uid);
  end if;

  insert into invites(email, full_name, role, created_by) values (v_email, trim(p_name), p_role, me.id)
  on conflict (email) do update set full_name = excluded.full_name, role = excluded.role,
                                    created_by = excluded.created_by, created_at = now(), used_at = null;
  perform log_account_(me, 'Pozvaný: ' || trim(p_name) || ' <' || v_email || '>', '', p_role);
  return jsonb_build_object('msg', 'Pozvánka pre ' || v_email || ' je pripravená.');
end $$;

create or replace function api_invite_delete(p_email text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v invites%rowtype;
begin
  me := require_role_('admin');
  select * into v from invites where email = lower(trim(coalesce(p_email, '')));
  if not found then return jsonb_build_object('msg', 'Pozvánka už neexistuje.'); end if;
  if v.role = 'owner' and me.role <> 'owner' then raise exception 'ROLE: Pozvánku vlastníka môže zrušiť len vlastník.'; end if;
  delete from invites where email = v.email;
  perform log_account_(me, 'Zrušená pozvánka: ' || v.email, v.role, '');
  return jsonb_build_object('msg', 'Pozvánka zrušená.');
end $$;

-- Змінити ім'я / роль / вимикач. null = «не змінювати».
create or replace function api_person_update(p_id uuid, p_name text default null, p_role text default null,
                                             p_active boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; t profiles; v_role text; v_active boolean; v_name text;
begin
  me := require_role_('admin');
  select * into t from profiles where id = p_id for update;
  if not found then raise exception 'Taký človek v programe nie je.'; end if;

  v_role   := coalesce(p_role, t.role);
  v_active := coalesce(p_active, t.is_active);
  v_name   := coalesce(nullif(trim(p_name), ''), t.full_name);

  if v_role not in ('owner', 'admin', 'member') then raise exception 'Neplatná rola.'; end if;
  if me.role <> 'owner' and t.role = 'owner' then raise exception 'ROLE: Vlastníka môže upravovať len iný vlastník.'; end if;
  if me.role <> 'owner' and v_role = 'owner' then raise exception 'ROLE: Vlastníka môže určiť len vlastník.'; end if;
  if t.id = me.id and not v_active then raise exception 'Seba vypnúť nemôžete — zamkli by ste sa zvonku.'; end if;
  if t.role = 'owner' and (v_role <> 'owner' or not v_active) and other_owners_(t.id) = 0 then
    raise exception 'V programe musí zostať aspoň jeden vlastník. Najprv určte vlastníkom niekoho iného.';
  end if;

  update profiles set full_name = v_name, role = v_role, is_active = v_active, updated_at = now() where id = t.id;

  if v_role <> t.role then
    perform log_account_(me, 'Zmena roly: ' || who_(t), t.role, v_role);
  end if;
  if v_active <> t.is_active then
    perform log_account_(me, case when v_active then 'Zapnutý prístup: ' else 'Vypnutý prístup: ' end || who_(t),
                         case when t.is_active then 'aktívny' else 'vypnutý' end,
                         case when v_active then 'aktívny' else 'vypnutý' end);
  end if;
  if v_name <> t.full_name then
    perform log_account_(me, 'Zmena mena: ' || t.email, t.full_name, v_name);
  end if;
  return jsonb_build_object('msg', 'Uložené.');
end $$;

-- Нове heslo для людини (забула своє). Пароль зберігається тим самим способом,
-- що й у Supabase (bcrypt у auth.users) — вхід працює одразу.
create or replace function api_person_password(p_id uuid, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare me profiles; t profiles;
begin
  me := require_role_('admin');
  select * into t from profiles where id = p_id;
  if not found then raise exception 'Taký človek v programe nie je.'; end if;
  if me.role <> 'owner' and t.role = 'owner' then raise exception 'ROLE: Heslo vlastníka môže zmeniť len vlastník.'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Heslo musí mať aspoň 6 znakov.'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf', 10)), updated_at = now() where id = t.id;
  perform log_account_(me, 'Nové heslo: ' || who_(t));
  return jsonb_build_object('msg', 'Heslo pre ' || who_(t) || ' je zmenené.');
end $$;

-- Видалити назовсім: прибирається сам логін (auth.users), профіль — слідом.
-- Підписи в журналі лишаються (там ім'я текстом).
create or replace function api_person_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; t profiles;
begin
  me := require_role_('admin');
  select * into t from profiles where id = p_id;
  if not found then raise exception 'Taký človek v programe nie je.'; end if;
  if t.id = me.id then raise exception 'Seba zmazať nemôžete. Požiadajte iného vlastníka.'; end if;
  if me.role <> 'owner' and t.role = 'owner' then raise exception 'ROLE: Vlastníka môže zmazať len iný vlastník.'; end if;
  if t.role = 'owner' and other_owners_(t.id) = 0 then raise exception 'Toto je posledný vlastník programu — zmazať sa nedá.'; end if;

  -- і запрошення: інакше людина зареєструвалась би знову старим
  delete from invites where email = t.email;
  delete from auth.users where id = t.id;
  perform log_account_(me, 'Zmazaný účet: ' || who_(t) || ' <' || t.email || '>', t.role, '');
  return jsonb_build_object('msg', who_(t) || ' bol odstránený z programu.');
end $$;

-- ------------------------------------------------------------- права

-- Спершу забрати ВСЕ в усіх (Supabase за замовчуванням дає нові функції
-- анонімові), потім видати рівно потрібне і лише тим, хто увійшов.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function
  api_init(), api_items(bigint), api_changes(bigint, bigint), api_logs(bigint, int),
  api_scan(text, bigint, integer, text, text), api_note(bigint, text),
  api_sheet_create(text), api_sheet_delete(bigint),
  api_items_save(bigint, jsonb),
  api_import(bigint, jsonb, text, boolean), api_import_done(bigint, int, text),
  api_backup_list(), api_backup_delete(bigint), api_backup_restore(bigint),
  api_logs_all(bigint, int), api_logs_clear(),
  api_people(), api_invite_save(text, text, text), api_invite_delete(text),
  api_person_update(uuid, text, text, boolean), api_person_password(uuid, text), api_person_delete(uuid)
to authenticated;

-- Реєстрацію виконує служба Supabase під роллю supabase_auth_admin — саме вона
-- запускає тригер handle_new_user. Даємо їй рівно це (урок з Flex, міграція 018).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant usage on schema public to supabase_auth_admin';
    execute 'grant execute on function public.handle_new_user() to supabase_auth_admin';
  end if;
end $$;

-- Великі операції: більше часу, ніж типові 8 с для authenticated.
alter function api_import(bigint, jsonb, text, boolean)  set statement_timeout = '60s';
alter function api_backup_restore(bigint)                 set statement_timeout = '60s';
alter function api_sheet_delete(bigint)                   set statement_timeout = '60s';
alter function api_items_save(bigint, jsonb)              set statement_timeout = '60s';
alter function api_logs_all(bigint, int)                  set statement_timeout = '30s';

-- =====================================================================
-- ПЕРЕВІРКА — у результаті внизу має бути:
--   anon_moze = false у КОЖНОМУ рядку (без входу не можна нічого),
--   prihlaseny_moze = true у кожному рядку.
-- =====================================================================
select p.proname as funkcia,
       has_function_privilege('anon', p.oid, 'execute')          as anon_moze,
       has_function_privilege('authenticated', p.oid, 'execute') as prihlaseny_moze
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'api\_%'
 order by 2 desc, 1;
