-- =====================================================================
-- Skladový terminál — табличний редактор складу + журнал       v3.1.1–v3.1.2
-- Виконати ОДИН раз: Supabase → SQL Editor → New query → вставити → Run.
--
-- api_items_save: зберігає пачку змін з табличного редактора (правки
-- клітинок, нові рядки, видалення). Кожен рядок обробляється окремо:
-- помилка в одному (напр. дубль PLU) не скасовує решту.
--
-- ТОЧНІСТЬ: якщо в таблиці змінили Realita, клієнт надсилає і стару
-- Realita, яку бачила людина (old_real). Якщо в базі вона вже інша (хтось
-- у цей час сканував), Realita НЕ перезаписується — повертається конфлікт,
-- а решта полів рядка зберігається.
-- =====================================================================

-- прибрати тимчасову функцію перенесення даних (якщо ще є)
drop function if exists api_migrate_tmp(text, text, jsonb, boolean);

create or replace function int_or_(p text, p_default int) returns int
language sql immutable as $$
  select case when nullif(trim(coalesce(p, '')), '') is null then p_default
              else round(replace(trim(p), ',', '.')::numeric)::int end;
$$;

-- p_changes: [
--   {"op":"update","id":123,"fields":{"name":"…","real":5,…},"old_real":3},
--   {"op":"insert","tmp":"new_1","fields":{"plu":"…","name":"…",…}},
--   {"op":"delete","id":456}
-- ]
create or replace function api_items_save(p_pin text, p_sheet_id bigint, p_changes jsonb, p_worker text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c jsonb; f jsonb; it items%rowtype; v_id bigint; v_sheet_name text;
  v_upd int := 0; v_ins int := 0; v_del int := 0;
  v_conf jsonb := '[]'::jsonb; v_err jsonb := '[]'::jsonb; v_new jsonb := '[]'::jsonb;
  v_real int; v_skip_real boolean; v_plu text;
begin
  perform require_pin_(p_pin);
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
      -- ------------------------------------------------ видалення
      if c->>'op' = 'delete' then
        delete from items where id = (c->>'id')::bigint and sheet_id = p_sheet_id returning * into it;
        if found then
          v_del := v_del + 1;
          insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
          values (p_sheet_id, v_sheet_name, it.id, it.plu, it.name, it.code, it.ean,
                  'ADMIN_DEL', it.real::text, '', coalesce(p_worker, ''));
        end if;

      -- ------------------------------------------------ новий рядок
      elsif c->>'op' = 'insert' then
        v_plu := trim(coalesce(f->>'plu', ''));
        if v_plu = '' then raise exception 'PLU je povinné.'; end if;
        insert into items(sheet_id, brand, plu, name, code, ean, plan, real, note, updated_by)
        values (p_sheet_id, trim(coalesce(f->>'brand', '')), v_plu, trim(coalesce(f->>'name', '')),
                trim(coalesce(f->>'code', '')), trim(coalesce(f->>'ean', '')),
                int_or_(f->>'plan', 0), greatest(0, int_or_(f->>'real', 0)),
                coalesce(f->>'note', ''), coalesce(p_worker, ''))
        returning id into v_id;
        v_ins := v_ins + 1;
        v_new := v_new || jsonb_build_array(jsonb_build_object('tmp', c->>'tmp', 'id', v_id));
        insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
        values (p_sheet_id, v_sheet_name, v_id, v_plu, trim(coalesce(f->>'name', '')),
                trim(coalesce(f->>'code', '')), trim(coalesce(f->>'ean', '')),
                'ADMIN_ADD', '0', greatest(0, int_or_(f->>'real', 0))::text, coalesce(p_worker, ''));

      -- ------------------------------------------------ зміна рядка
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
          updated_at = now(), updated_by = coalesce(p_worker, '')
        where id = it.id;
        v_upd := v_upd + 1;

        insert into log(sheet_id, sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker)
        values (p_sheet_id, v_sheet_name, it.id,
                case when f ? 'plu'  then trim(f->>'plu') else it.plu end,
                case when f ? 'name' then trim(coalesce(f->>'name', '')) else it.name end,
                case when f ? 'code' then trim(coalesce(f->>'code', '')) else it.code end,
                case when f ? 'ean'  then trim(coalesce(f->>'ean', ''))  else it.ean  end,
                'ÚPRAVA', it.real::text, v_real::text, coalesce(p_worker, ''));
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

revoke all on function api_items_save(text, bigint, jsonb, text) from public;
revoke all on function int_or_(text, int) from public;
grant execute on function api_items_save(text, bigint, jsonb, text) to anon, authenticated;
alter function api_items_save(text, bigint, jsonb, text) set statement_timeout = '60s';

-- ---------------------------------------------------------------------
-- v3.1.2: журнал змін у вигляді таблиці (Administrácia → História).
-- Увесь журнал (усі склади або один), найновіше зверху. Лише з PIN.
-- ---------------------------------------------------------------------
create or replace function api_logs_all(p_pin text, p_sheet_id bigint default null, p_limit int default 20000)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform require_pin_(p_pin);
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

revoke all on function api_logs_all(text, bigint, int) from public;
grant execute on function api_logs_all(text, bigint, int) to anon, authenticated;
alter function api_logs_all(text, bigint, int) set statement_timeout = '30s';
