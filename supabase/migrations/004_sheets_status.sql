-- =====================================================================
-- Skladový terminál — ПРЕГЛЯД І СТАТУСИ СКЛАДІВ + ІСТОРІЮ СТИРАЄ ЛИШЕ ВЛАСНИК   v3.1.4
--
-- ЯК ВИКОНАТИ:
--   Supabase → проект sklad-terminal → SQL Editor → New query →
--   вставити ВЕСЬ цей файл → Run. Повторний запуск нічого не псує.
--   (003_accounts_roles.sql має бути вже виконаний.)
--
-- ЩО ЗМІНЮЄТЬСЯ:
--   * У кожного складу (списку інвентури) з'являється СТАТУС:
--       prep     — Príprava   (завантажили, ще не почали рахувати)
--       active   — Prebieha   (інвентура йде; ставиться САМ при першому скані)
--       done     — Dokončený  (порахували; скан ще можливий, але термінал попередить)
--       archived — Archív     (у виборі складу для терміналу не показується)
--     Уже наявні склади отримають «Prebieha», якщо в них щось наскановано,
--     інакше «Príprava».
--   * Адміністрація бачить повний список складів: коли створений, стан,
--     скільки позицій і скільки пораховано, коли і хто працював востаннє.
--     Склад можна перейменувати і змінити йому стан (пишеться в журнал).
--   * Стерти історію (журнал) може лише ВЛАСНИК — журнал є і контролем дій
--     správcu (рішення власника 29.09.2026).
--   * Відновлення з бекапу шукає склад спершу за номером, а не за назвою —
--     інакше після перейменування бекап відновився б у НОВИЙ склад зі старою назвою.
-- =====================================================================

-- ------------------------------------------------------------- статус складу

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'sheets' and column_name = 'status') then
    alter table sheets add column status text not null default 'prep';
    alter table sheets add constraint sheets_status_check check (status in ('prep', 'active', 'done', 'archived'));
    -- склади, у яких уже рахували, — «Prebieha»
    update sheets s set status = 'active'
     where exists (select 1 from items i where i.sheet_id = s.id and i.real > 0);
  end if;
end $$;

-- Словацька назва стану — для журналу (там має бути зрозуміло без довідника).
create or replace function status_label_(p text) returns text
language sql immutable as $$
  select case p when 'prep' then 'Príprava' when 'active' then 'Prebieha'
                when 'done' then 'Dokončený' when 'archived' then 'Archív' else coalesce(p, '') end;
$$;

-- ------------------------------------------------------------- старт: склади зі статусом

create or replace function api_init() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p profiles;
begin
  p := me_();
  return jsonb_build_object(
    'sheets', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'name', name, 'status', status) order by name)
                        from sheets), '[]'::jsonb),
    'me', jsonb_build_object('id', p.id, 'email', p.email, 'name', who_(p), 'role', p.role),
    'serverTime', (extract(epoch from now()) * 1000)::bigint
  );
end $$;

-- ------------------------------------------------------------- перший скан: Príprava → Prebieha

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
  -- інвентура почалась: «Príprava» → «Prebieha» (інші стани не чіпаємо)
  update sheets set status = 'active' where id = it.sheet_id and status = 'prep';

  insert into log(client_time, sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker, user_id)
  values (coalesce(p_client_time, ''), it.sheet_id, (select name from sheets where id = it.sheet_id), it.id,
          it.plu, it.name, it.code, it.ean, case when p_type = 'scan' then 'SKEN' else 'MANUÁL' end,
          v_old::text, v_new::text, who_(me), me.id);

  v_res := jsonb_build_object('id', it.id, 'oldReal', v_old, 'newReal', v_new,
                              'serverTime', (extract(epoch from now()) * 1000)::bigint);
  insert into ops(op_id, result) values (p_op_id, v_res);
  return v_res;
end $$;

-- ------------------------------------------------------------- огляд складів (Správca+)

-- Усі склади з цифрами: позиції, план, реальність, скільки «сходиться», коли
-- створений і коли/хто працював востаннє. Останню дію беремо з журналу (там є
-- і що саме зроблено); якщо журнал стерли — з часу останньої зміни позиції.
create or replace function api_sheets() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform require_role_('admin');
  return jsonb_build_object('sheets', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id::text, 'name', s.name, 'status', s.status,
             'created', to_char(s.created_at at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI'),
             'items', coalesce(a.cnt, 0), 'plan', coalesce(a.plan, 0), 'real', coalesce(a.real, 0),
             'done', coalesce(a.done, 0), 'capped', coalesce(a.capped, 0),
             'lastTs', (extract(epoch from greatest(ll.at, li.updated_at)) * 1000)::bigint,
             'last', coalesce(to_char(greatest(ll.at, li.updated_at) at time zone 'Europe/Bratislava', 'DD.MM.YYYY HH24:MI'), ''),
             'lastBy', case when ll.at is not null and (li.updated_at is null or ll.at >= li.updated_at)
                            then ll.worker else coalesce(li.updated_by, '') end,
             'lastAction', case when ll.at is not null and (li.updated_at is null or ll.at >= li.updated_at)
                                then ll.action else '' end)
           order by s.name)
      from sheets s
      left join (select sheet_id, count(*) as cnt, sum(plan) as plan, sum(real) as real,
                        count(*) filter (where real >= plan) as done, sum(least(real, plan)) as capped
                   from items group by sheet_id) a on a.sheet_id = s.id
      left join lateral (select l.at, l.worker, l.action from log l
                          where l.sheet_id = s.id order by l.id desc limit 1) ll on true
      left join lateral (select i.updated_at, i.updated_by from items i
                          where i.sheet_id = s.id order by i.updated_at desc limit 1) li on true
  ), '[]'::jsonb));
end $$;

-- Перейменувати і/або змінити стан. null = «не змінювати». Обидві дії — у журнал.
create or replace function api_sheet_update(p_sheet_id bigint, p_name text default null, p_status text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; s sheets%rowtype; v_name text;
begin
  me := require_role_('admin');
  select * into s from sheets where id = p_sheet_id for update;
  if not found then raise exception 'Sklad nenájdený.'; end if;
  v_name := coalesce(nullif(trim(p_name), ''), s.name);
  if p_status is not null and p_status not in ('prep', 'active', 'done', 'archived') then
    raise exception 'Neplatný stav skladu.';
  end if;

  update sheets set name = v_name, status = coalesce(p_status, s.status) where id = s.id;

  if v_name <> s.name then
    insert into log(sheet_id, sheet_name, action, name, old_val, new_val, worker, user_id)
    values (s.id, v_name, 'SKLAD', 'Premenovaný sklad', s.name, v_name, who_(me), me.id);
  end if;
  if p_status is not null and p_status <> s.status then
    insert into log(sheet_id, sheet_name, action, name, old_val, new_val, worker, user_id)
    values (s.id, v_name, 'SKLAD', 'Zmena stavu skladu', status_label_(s.status), status_label_(p_status), who_(me), me.id);
  end if;
  return jsonb_build_object('msg', 'Uložené.');
exception when unique_violation then
  raise exception 'Sklad s týmto názvom už existuje.';
end $$;

-- ------------------------------------------------------------- журнал: стирає лише власник

create or replace function api_logs_clear() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; v int;
begin
  me := require_role_('owner');
  delete from log; get diagnostics v = row_count;
  delete from ops where at < now() - interval '2 days';
  -- хто стер журнал — перший запис нового журналу
  insert into log(action, name, worker, user_id) values ('CLEAR', 'Vymazaná história (' || v || ' záznamov)', who_(me), me.id);
  return jsonb_build_object('msg', 'Logy vymazané (' || v || ' záznamov).');
end $$;

-- ------------------------------------------------------------- бекап: склад за номером

-- ВИПРАВЛЕНО: раніше склад для відновлення шукався лише за назвою. Після
-- перейменування (з'явилось у v3.1.4) бекап відновився б у НОВИЙ склад зі старою
-- назвою. Тепер: спершу той самий склад за номером, потім за назвою, інакше новий.
create or replace function api_backup_restore(p_backup_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me profiles; b backups%rowtype; v_sheet bigint; v_name text;
begin
  me := require_role_('admin');
  select * into b from backups where id = p_backup_id;
  if not found then raise exception 'Záloha nenájdená.'; end if;
  select id, name into v_sheet, v_name from sheets where id = b.sheet_id;
  if v_sheet is null then select id, name into v_sheet, v_name from sheets where name = b.sheet_name; end if;
  if v_sheet is null then
    insert into sheets(name) values (b.sheet_name) returning id, name into v_sheet, v_name;
  else
    perform backup_sheet_(v_sheet, 'PRED OBNOVENÍM');
    delete from items where sheet_id = v_sheet;
  end if;
  insert into items(sheet_id, brand, plu, name, code, ean, plan, real, note, updated_by)
  select v_sheet, coalesce(r->>'brand',''), r->>'plu', coalesce(r->>'name',''), coalesce(r->>'code',''),
         coalesce(r->>'ean',''), coalesce((r->>'plan')::int,0), coalesce((r->>'real')::int,0),
         coalesce(r->>'note',''), 'Obnova'
  from jsonb_array_elements(b.data) r;
  insert into log(sheet_id, sheet_name, action, name, worker, user_id)
  values (v_sheet, v_name, 'IMPORT', 'Obnovené zo zálohy (' || b.row_count || ' r.)', who_(me), me.id);
  return jsonb_build_object('msg', 'Sklad «' || v_name || '» obnovený (' || b.row_count || ' položiek).');
end $$;

-- ------------------------------------------------------------- права

revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function
  api_init(), api_items(bigint), api_changes(bigint, bigint), api_logs(bigint, int),
  api_scan(text, bigint, integer, text, text), api_note(bigint, text),
  api_sheet_create(text), api_sheet_delete(bigint), api_sheets(), api_sheet_update(bigint, text, text),
  api_items_save(bigint, jsonb),
  api_import(bigint, jsonb, text, boolean), api_import_done(bigint, int, text),
  api_backup_list(), api_backup_delete(bigint), api_backup_restore(bigint),
  api_logs_all(bigint, int), api_logs_clear(),
  api_people(), api_invite_save(text, text, text), api_invite_delete(text),
  api_person_update(uuid, text, text, boolean), api_person_password(uuid, text), api_person_delete(uuid)
to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.handle_new_user() to supabase_auth_admin';
  end if;
end $$;

alter function api_backup_restore(bigint) set statement_timeout = '60s';

-- =====================================================================
-- ПЕРЕВІРКА — у результаті внизу має бути видно ваші склади з їхнім станом
-- (stav) і кількістю позицій (poloziek).
-- =====================================================================
select s.name as sklad, status_label_(s.status) as stav,
       (select count(*) from items i where i.sheet_id = s.id) as poloziek,
       to_char(s.created_at at time zone 'Europe/Bratislava', 'DD.MM.YYYY') as vytvoreny
  from sheets s
 order by s.name;
