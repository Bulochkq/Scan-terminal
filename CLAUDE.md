# Skladový terminál — контекст для Claude

Складський термінал для щорічної інвентаризації: працівники сканують товар (PLU / EAN / SKU),
система рахує **Realita** проти **Plán** (план = залишок з ERP). До 24 000 позицій, до 20 людей,
дві точки в Братиславі (кожна — своя копія таблиці + скрипта).

Мова: користувач — українською; коментарі в коді — українською; **інтерфейс — словацькою**
(не перекладати UI-рядки).

## Обов'язкові правила роботи (від власника проекту)

1. **Версія піднімається при кожній зміні**, що йде в роботу: `3.0.2 → 3.0.3 → …` (третя цифра).
   Змінити `APP_VERSION` у `web/js/config.js` (видно на стартовому екрані) і `VERSION` у `web/sw.js`.
   У заголовку кожного зміненого файлу — примітка `Остання зміна: vX.Y.Z`.
2. **Кожну зміну записати в `PROGRESS.md`** від свого імені, найновіше зверху: версія · дата · хто ·
   що і чому · файли · стан деплою. Так інша AI зможе відновити контекст.
3. **План робіт — `TODO.md`.** Зроблене позначати `[x]` з версією.
4. Фронтенд деплоїть AI сам: `npx wrangler@4 deploy` з кореня (див. `wrangler.jsonc`), потім перевірити
   версію на живому сайті. Зміни бази (SQL) запускає власник у Supabase SQL Editor — дати йому
   готовий SQL і пояснити простими словами, що він робить.
5. **Жодних емодзі в інтерфейсі** (рішення власника 29.09.2026). Лише однотонні лінійні іконки
   ОДНОГО набору — Lucide (як у Flex Bike Analytics). HTML: `<svg class="ic"><use href="#i-назва"></use></svg>`,
   JS: `icon('назва')`. Нова іконка — дописати в `tools/build-icons.js` і запустити `node tools/build-icons.js`
   (спрайт у `web/index.html` між мітками ICONS). Випадні списки — лише стилізовані
   (`<select class="custom-select">` + `renderCustomSelects()`), не системні.

## Архітектура (з v3.1.0)

```
браузер (web/, Cloudflare Worker «sklad-terminal», static assets)
  config.js  — SUPABASE_URL + SUPABASE_KEY (публічний sb_publishable_…)
  auth.js    — вхід (supabase-js, Supabase Auth: e-mail + heslo), токен, ролі (з v3.1.3)
  api.js     — fetch POST {URL}/rest/v1/rpc/api_* + Bearer-токен; повтори; Outbox (localStorage, запис на кожен opId)
  people.js  — «Ľudia a prístupy»: люди, ролі, запрошення, паролі (Správca+)
  sheets.js  — адмінка: список складів, картка складу (стан, перейменування, журнал складу) (v3.1.4)
  icons.js   — icon('назва') для HTML з JS; самі іконки — спрайт у index.html (v3.1.4)
  app.js     — UI, сканування, пачки натискань → одна дельта, синхронізація api_changes кожні 5 с
  importer.js— PDF.js/SheetJS у браузері → api_import порціями по 2000
        │
        ▼
Supabase (Postgres, проект sklad-terminal, https://wpqmzxwqnbnmemjtgsom.supabase.co)
  supabase/migrations/001_init.sql — таблиці sheets/workers/items/log/ops/backups/settings,
  RLS без політик (таблиці з браузера недоступні), уся логіка у функціях api_* (SECURITY DEFINER)
  003_accounts_roles.sql — profiles/invites (+ auth.users), ролі, усі api_* лише для authenticated
  004_sheets_status.sql  — sheets.status (prep/active/done/archived), api_sheets, api_sheet_update
```

- Позиція ідентифікується `items.id`; у фронтенді це поле `row` (так історично названо).
- **Скан = дельта:** `api_scan(p_op_id, p_item_id, p_delta, …)` атомарно додає; `ops` робить повтор
  з тим самим opId безпечним. Ніколи не повертатись до запису абсолютного значення.
- **Вхід і ролі (з v3.1.3):** Supabase Auth (e-mail + пароль), `profiles.role` = `owner` (Vlastník) /
  `admin` (Správca) / `member` (Pracovník). Схема навмисно така сама, як у Flex Bike Analytics
  (`../Flex nastroj/flex-bike-analytics`, міграції 017–018) — щоб колись злити акаунти за e-mailом.
  Кожна `api_*` починається з `me_()` або `require_role_('admin')`; хто зробив дію — з `auth.uid()`,
  ніколи з параметра від браузера. `AUTH:` → фронтенд показує вхід; `ROLE:` → лише повідомлення.
  Правила: správca не чіпає власників; себе не вимикаєш/не видаляєш; останній власник недоторканний.
  Власник — `select invite_owner('e-mail', 'Meno');` з SQL Editor (також «повернути собі права»).
- Зміни схеми: новий файл `supabase/migrations/00N_*.sql`; власник запускає його в SQL Editor.
  `create or replace function` + **`grant execute … to authenticated`** (НЕ anon) для кожної нової
  api_* функції; наприкінці файла — `revoke all on all functions … from public, anon, authenticated`
  і повторна видача (Supabase за замовчуванням дає нові функції анонімові).
- Перевірка SQL без бази власника: PGlite (Postgres у WASM) з імітацією `auth.users` / `auth.uid()`
  (приклад — скрипт `test003.mjs` у PROGRESS v3.1.3).
- Стани складу (v3.1.4): `prep` Príprava → (перший скан) `active` Prebieha → `done` Dokončený
  (термінал питає перед сканом) → `archived` Archív (не видно у виборі складу для терміналу).
  Стирати журнал (`api_logs_clear`) може лише `owner`.
- Free-план Supabase: проект засинає після 7 днів простою (TODO: cron-пінг), автоматичних бекапів немає.

**Історичне (не використовується з v3.1.0):** `gas/` — Apps Script JSON API над Google Таблицею;
корінь (`Main.gs`, `Scripts.html`, …) — v2 на HtmlService. 15 функцій у них мають однакові імена —
не змішувати. Apps Script відмовились через затримки 3–68 с і 404 (заміри в PROGRESS.md, v3.0.1–v3.0.3).

## Інваріанти

- `escapeHtml()` для всього, що вставляється в HTML.
- PLU/ID з `data-*` читати через `.attr()`, не `.data()` (jQuery перетворює "0012" на 12).
- Будь-яка відповідь бази перевіряється на очікуване поле (`EXPECT` в api.js).
- Після зміни файлів `web/` — підняти `VERSION` у `web/sw.js` і `APP_VERSION`.
- Секретний ключ Supabase (`sb_secret_…`) ніколи не потрапляє в код чи репо (репо публічне).
- Скан, який не вдалось відправити через зв'язок АБО втрату входу (`isAuth`), лишається в Outbox —
  видаляється лише підтверджене базою або справжня помилка (позиції не існує).

## Деплой і перевірка

- Збірки, npm, тестів немає. Фронтенд — ES5 + jQuery 3.7.1.
- Фронтенд: `npx wrangler@4 deploy` з кореня (wrangler залогінений), потім перевірити
  `curl …/js/config.js` на живому сайті https://sklad-terminal.velocity-app.workers.dev.
  (29.09.2026 піддомен workers.dev акаунта змінився з `ustymenko-yurii-s` на `velocity-app` — стара
  адреса не працює. Після деплою дивись, яку адресу друкує wrangler, і звір з цією.)
- База: SQL-файл → власник запускає в Supabase SQL Editor. Перевірка з консолі:
  `curl -X POST {URL}/rest/v1/rpc/api_init -H "apikey: {KEY}" -H "Content-Type: application/json" -d '{}'`.
- Синтаксис: `node --check` для `web/js/*.js`.

## Стиль коду

- ES5: `var`, `function`, проміси через `.then` (без `async/await`, без стрілок у `web/js/*`; у `sw.js` стрілки є).
- Приватні серверні функції закінчуються на `_` (`apiWrite_`, `getSheetById_`).
- Виправлені баги позначені коментарем `// ВИПРАВЛЕНО:` з поясненням, що було не так — зберігати цю традицію.
- Коментарі пояснюють *чому* (швидкість, квоти, CORS), а не *що*.
