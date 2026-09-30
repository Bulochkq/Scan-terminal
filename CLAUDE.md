# Skladový terminál — повний контекст для Claude

> Цей файл — головна точка входу для нової сесії. Прочитай його повністю, потім верхній запис
> `PROGRESS.md` і розділ «Далі» в `TODO.md`. Цього досить, щоб продовжити без попередньої розмови.
> Стан актуальний на **30.09.2026, версія v3.1.6**.

## 1. Що це і для кого

Складський термінал для **щорічної інвентаризації** у власних магазинах (Братислава). Працівники
сканують товар (PLU / EAN / SKU) — сканером-пістолетом (дротовим або Bluetooth, працює як клавіатура)
або камерою телефону; система рахує **Realita** проти **Plán** (план = залишок з ERP, імпорт XLSX/PDF).

- Масштаб: 1–20 складів (списків інвентури), до ~27 000 позицій на склад, одночасно 1–3 людини,
  до ~20 акаунтів. Працівники майже завжди онлайн. Головна вимога — **точність даних**.
- Безкоштовний хостинг: Cloudflare (фронтенд) + Supabase free (база).
- Власник — самоук, пише українською. **Пояснювати простими словами, покроково.**
- Мови: спілкування — українською; **коментарі в коді — українською**; **інтерфейс — словацькою**
  (UI-рядки не перекладати).

## 2. Обов'язкові правила роботи (від власника)

1. **Кожна зміна, що йде в роботу, піднімає версію на +1 у третій цифрі** (`3.1.5 → 3.1.6`):
   `APP_VERSION` у `web/js/config.js` (видно на екрані входу) **і** `VERSION` у `web/sw.js` (`v20 → v21`);
   у заголовку кожного зміненого файлу — `Остання зміна: vX.Y.Z`.
2. **Кожну зміну записати в `PROGRESS.md`** від свого імені, найновіше зверху:
   версія · дата · хто · що і **чому** · перевірки · файли · деплой (ID версії Cloudflare).
3. **План — `TODO.md`**; зроблене `[x]` з версією; нові ідеї власника — туди ж.
4. **Фронтенд деплоїть AI сам** (див. §6) і перевіряє версію на живому сайті.
   **SQL запускає власник** у Supabase SQL Editor — дати готовий файл і пояснити простими словами.
   Секретний ключ Supabase, пароль бази чи PIN у власника **не просити**.
5. **Жодних емодзі в інтерфейсі.** Лише однотонні лінійні іконки одного набору — **Lucide**
   (той самий, що у Flex Bike Analytics). Випадні списки — **лише стилізовані**, не системні.
   Вікна й кнопки — прямокутники з невеликим заокругленням (`--r-sm..--r-xl` = 4–10 px). Дизайн
   компактний і єдиний: кольори/розміри лише через змінні `:root` у `web/css/app.css`.
6. Git: гілка `update-code`, репо GitHub `Bulochkq/Scan-terminal` **публічне**. До v3.1.5 включно
   закомічено й запушено (`d9bc02e`, `b6ba002`); зміни v3.1.6 ще не закомічені. Комітити лише коли
   власник попросить. `Skladove_karty_Hayes_test.xlsx` не комітити (там ціни) — **він уже потрапив у
   `d9bc02e` і лежить на GitHub** (хоч і в `.gitignore`): що з ним робити, вирішує власник (див. TODO).

## 3. Поточний стан (v3.1.6)

- **Живий сайт:** https://sklad-terminal.velocity-app.workers.dev — власник вирішив **лишити цю адресу**
  (29.09.2026 піддомен workers.dev акаунта Cloudflare змінили з `ustymenko-yurii-s` на `velocity-app`;
  стара адреса мертва). Останній деплой: Cloudflare version `662c159b`.
- **Supabase:** проект `sklad-terminal` (org `bulochkq`, Європа), URL `https://wpqmzxwqnbnmemjtgsom.supabase.co`,
  публічний ключ `sb_publishable_1Ngw3BDLm2Nhjj4quEb01A_8CqclSbK` (у `web/js/config.js`).
  Не плутати з іншими проектами власника: «Flex Analytics» (живий, інший продукт) і «bike-service».
- **Міграції:**

  | Файл | Що | Стан |
  |---|---|---|
  | `001_init.sql` | таблиці, api_* (стара PIN-версія) | виконано |
  | `002_table_editor.sql` | таблиця-редактор + журнал (PIN) | **не запускати** — усе є в 003 |
  | `003_accounts_roles.sql` | вхід, ролі, усі api_* без PIN | виконано, власник увійшов як Vlastník |
  | `004_sheets_status.sql` | стани складів, огляд, перейменування, журнал стирає лише owner | виконано (перевірено 30.09) |

  Перевірити, чи функція є в базі, без входу: `curl -s -X POST {URL}/rest/v1/rpc/api_sheets -H "apikey: {KEY}" -H "Content-Type: application/json" -d '{}'`
  → `PGRST202` («Could not find the function») = міграцію не запущено; `permission denied` / 401 = функція є.

## 4. Архітектура

```
браузер (web/ → Cloudflare Worker «sklad-terminal», лише static assets, wrangler.jsonc → ./web)
  index.html   — уся розмітка; на початку <body> спрайт іконок між <!-- ICONS:BEGIN --> / <!-- ICONS:END -->
  css/app.css  — єдиний дизайн; токени в :root
  js/config.js — SUPABASE_URL, SUPABASE_KEY, SITE_NAME, APP_VERSION, інтервали
  js/icons.js  — icon('назва') → <svg class="ic"><use href="#i-назва"></use></svg>
  js/auth.js   — Supabase Auth через supabase-js 2.117.2 (jsdelivr, SRI): вхід, перший вхід, свій пароль,
                 вихід, створення акаунта іншій людині, токен, ролі, словацькі тексти помилок
  js/api.js    — POST {URL}/rest/v1/rpc/api_* + Bearer-токен; повтори; EXPECT; Outbox
  js/app.js    — екран входу/старту, термінал (скан, пачки, синхронізація), адмін-дії, модалки, custom select
  js/sheets.js — головна: склади (телефон — картки в адмінці; ПК — таблиця на всю сторінку #homeDesk),
                 картка складу (#sheetModal; ПК — панель справа), меню головної на ПК (global.Home)
  js/people.js — «Ľudia a prístupy»: люди, ролі, запрошення, паролі
  js/editor.js — Editor (таблиця товарів, Tabulator 6.3.1 з cdnjs, лінивий) + LogView (журнал)
  js/importer.js — імпорт XLSX/CSV/PDF (SheetJS/PDF.js ліниві) → api_import порціями по 2000
  sw.js        — service worker: свої файли stale-while-revalidate, CDN cache-first, supabase.co не чіпає
        │  HTTPS, токен входу (JWT) у заголовку Authorization
        ▼
Supabase Postgres: RLS увімкнено БЕЗ політик (таблиці з браузера недоступні взагалі);
  уся логіка — функції api_* (SECURITY DEFINER), EXECUTE лише для ролі authenticated.
tools/build-icons.js — збирає іконки Lucide 1.48.0 у спрайт index.html
tools/tests/         — тести (див. §7)
```

Історичне (не використовується з v3.1.0): `gas/` (Apps Script API) і корінь (`Main.gs`, `Scripts.html`… — v2).
Від Apps Script відмовились через затримки 3–95 с і 404. 15 функцій у них мають однакові імена — не змішувати.

### 4.1 База (таблиці)
`sheets(id, name unique, created_at, status)` · `items(id, sheet_id, brand, plu text, name, code(SKU), ean,
plan, real ≥0, note, updated_at, updated_by; unique(sheet_id, plu))` · `log(id, at, client_time, sheet_id,
sheet_name, item_id, plu, name, code, ean, action, old_val, new_val, worker, user_id)` · `ops(op_id, at, result)` ·
`backups(id, sheet_id, sheet_name, reason, row_count, data jsonb, created_at)` · `settings` ·
`profiles(id→auth.users, email, full_name, role, is_active)` · `invites(email, full_name, role, created_by, used_at)` ·
`workers` (стара, не використовується).

Дії в журналі (`log.action`): SKEN, MANUÁL, POZNÁMKA, ÚPRAVA, ADMIN_ADD, ADMIN_DEL, IMPORT, DELETE, CLEAR,
ÚČET (люди/ролі), SKLAD (назва/стан складу). Мапа підписів — `ACTIONS` в editor.js.

### 4.2 Функції API (усі `api_*`, лише authenticated)
- Усі, хто увійшов (`me_()`): `api_init` (sheets зі status + me), `api_items`, `api_changes`, `api_logs`
  (1000 записів складу), `api_scan`, `api_note`.
- Správca+ (`require_role_('admin')`): `api_sheet_create/delete`, `api_sheets` (огляд), `api_sheet_update`
  (назва/стан), `api_items_save` (пачка змін таблиці з конфліктом Realita), `api_import`, `api_import_done`,
  `api_backup_list/delete/restore`, `api_logs_all(p_sheet_id?)`, `api_people`, `api_invite_save/delete`,
  `api_person_update/password/delete`.
- Лише owner: `api_logs_clear`.
- Лише з SQL Editor (браузеру недоступні): `invite_owner(email, meno)` — стати власником / повернути права;
  службові `me_`, `require_role_`, `who_`, `role_rank_`, `other_owners_`, `backup_sheet_`, `int_or_`,
  `status_label_`, `log_account_`, тригер `handle_new_user` на `auth.users`.

## 5. Ключові рішення й інваріанти (НЕ ламати)

**Точність даних**
- **Скан = дельта**, не абсолютне значення: `api_scan(p_op_id, p_item_id, p_delta, p_type, p_client_time)`
  атомарно додає; таблиця `ops` робить повтор того самого `opId` безпечним (повертає збережений результат).
- Кілька натискань поспіль збираються в одну «пачку» (`BATCH_DELAY_MS` 1,5 с) → одна дельта.
- **Outbox** (localStorage `termOutbox_v4`): окремий запис на кожен opId; видаляється лише підтверджене
  базою або справжня помилка (позиції нема). Помилка зв'язку **або втрата входу (`isAuth`)** — запис лишається.
  Закриття вкладки: пачка → Outbox + keepalive-запит.
- На екрані: значення з бази + ще не відправлене (Outbox + поточна пачка). Синхронізація `api_changes`
  кожні 5 с; якщо кількість позицій інша — повне перечитування.
- Таблиця (правка): шле лише змінені поля; при зміні Realita шле `old_real` — якщо в базі вже інше,
  Realita НЕ перезаписується (конфлікт у звіті). Перед видаленням рядків — бекап складу.
  Імпорт/відновлення/видалення складу — теж з бекапом. Відновлення шукає склад за id, потім за назвою.
- Імпорт (v3.1.6): з Excel кількість береться **числом з клітинки** (`vals`, `raw:true`), не текстом формату
  («#,##0» дає «1,234»); текст (CSV, PDF) — `parseQty` з десятковим знаком, який визначає **вся колонка**
  (`detectDecimal`). Коди, записані в Excel числом, — усі цифри (не «8.59E+12»); текстові — як є, з нулями.
  CSV читається з `raw:true` (SheetJS сам числа не розбирає). Повтор порції `api_import` безпечний (upsert за PLU).

**Вхід і ролі (v3.1.3)** — схема навмисно така сама, як у Flex Bike Analytics
(`C:\Users\ustym\OneDrive\Desktop\Flex nastroj\flex-bike-analytics`, міграції 017–018), щоб у майбутньому
злити акаунти двох програм за e-mailом (власник хоче колись одну програму зі спільними акаунтами — «не зараз»).
- Supabase Auth, e-mail + пароль (мін. 6). У Supabase: «Confirm email» **вимкнено**, «Allow new users to sign up»
  **увімкнено** (реєстрацію без запрошення відхиляє тригер `handle_new_user`).
- Ролі: `owner` Vlastník — усе; `admin` Správca — усе, крім власників (не змінює/не вимикає/не видаляє їх, нікого
  не робить власником) і крім стирання журналу; `member` Pracovník — скан, ручне +/−, нотатки (і в таблиці),
  перегляд Prehľad/Zoznam/História свого складу; без адмінки, правки таблиці, експорту, імпорту.
- Запобіжники: себе не вимикаєш і не видаляєш; останнього активного власника не можна понизити/вимкнути/видалити.
- Хто зробив дію — **завжди з `auth.uid()`** у базі, ніколи з параметра браузера.
- Помилки: `AUTH:` → фронтенд виходить і показує екран входу з причиною; `ROLE:` → лише повідомлення.
  HTTP 401 → одна спроба оновити токен, потім вихід.
- Нова людина («Pridať človeka»): `api_invite_save` → якщо заданий пароль, фронтенд одразу реєструє її
  окремим fetch на `/auth/v1/signup` (сесія адміна не змінюється). Пароль у формі **придуманий заздалегідь**
  (запрошення без пароля може «забрати» будь-хто, хто знає e-mail і адресу, поки людина не зайшла).
  Без пароля — людина сама на екрані входу «Prvé prihlásenie». Нове heslo адмін задає через
  `api_person_password` (bcrypt в `auth.users`). Свій пароль — вікно «Zmeniť heslo» (`updateUser`).
- Сесія: supabase-js (storageKey `sklad-auth`, сам оновлює токен між вкладками). Профіль кешується в
  `termMe_v1`; старт з кешу миттєвий, база підтверджує у фоні.
- Вихід спершу досилає Outbox; не вийшло — чесно попереджає, що скани підуть під наступним, хто увійде.
- На спільному ПК власник заведе окремий акаунт працівника (автовихід не потрібен).

**Склади (v3.1.4)** — `sheets.status`: `prep` Príprava → (сам з першим сканом) `active` Prebieha →
`done` Dokončený (термінал питає перед скануванням; у виборі складу підпис «— Dokončený») →
`archived` Archív (не показується у виборі складу для терміналу; запуск лише з картки складу).
Адмінка (власник/správca, відкрита одразу після входу): список складів (стан, позиції, % зроблено, остання робота),
архів під «Zobraziť archív»; картка складу: стан, створений, Položky/Sedí/Plán/Realita, «naposledy · хто · дія»,
дії Tovar na sklade, História skladu (журнал одного складу), Import, Export, Premenovať, Zmazať, Spustiť terminál.
% зроблено = Σ min(real, plan) / Σ plan (як «Prehľad» у терміналі).

**Інтерфейс**
- **Головна на ПК (v3.1.6)** — від 1024 px після входу `#setupOverlay.is-home` показує `#homeDesk` замість
  карток `#setupGrid` (телефон — картки, як раніше; обидва вигляди малює `Sheets.render()`). Бічне меню як у
  Flex (токени `--c-side-*`, `--w-side` 240 px): Sklady / História / Zálohy / Ľudia (`Home.go`), унизу людина й
  версія. «História», «Zálohy», «Ľudia» — ті самі повноекранні вікна, але CSS (`#setupOverlay.is-home:not(.hidden) ~ #…`)
  зсуває їх праворуч від меню; підсвітку меню веде `Home.syncNav` (MutationObserver; загальний журнал має клас
  `lg-all`). Таблиця товару та імпорт закривають і меню (там бувають незбережені зміни). Картка складу на ПК —
  панель справа (`--w-drawer` 460 px), фон під нею не ловить кліків (таблиця лишається живою), Esc закриває.
  Працівник на ПК: таблиця без цифр з `api_init` (`Sheets.setBasic`), клік по рядку — термінал.
  `Sheets.load(force)`: без force повторні виклики під час запиту отримують той самий запит.
- Таблиця товарів (Editor): за замовчуванням лише перегляд; нотатка — двоклік по клітинці, зберігається одразу
  (`api_note`); кнопки Skenovať (+1 як скан, лише в терміналі), Foto (Google), Poznámka; «Upraviť» (лише správca+)
  вмикає режим правки як у Google Таблиці, «Zamknúť» повертає. Телефон: ховаються Značka/SKU/EAN/Poznámka.
- Журнал (LogView): термінал — 1000 записів складу; адмінка — усі склади або один; «Vymazať históriu» лише власник
  і лише в загальному журналі.
- Вхід — **дві окремі форми** (`#loginForm` current-password, `#regForm` new-password двічі), щоб Chrome пропонував
  пароль у першому полі. «Ока» біля пароля немає.
- Іконки: HTML `<svg class="ic"><use href="#i-назва"></use></svg>`, JS `icon('назва', 'клас?')`. Нова іконка —
  дописати назву в `tools/build-icons.js` → `node tools/build-icons.js` (перезапише спрайт у index.html).
- Випадні списки: `<select class="custom-select">` + `renderCustomSelects(root?)`; варіанти класами на select:
  `cs-compact` (малий), `cs-dark` (на темному), `cs-up` (завжди вгору); неактивні `<option disabled title="чому">`.
- Вікно очікування — `setAdminBusy(true, 'текст')`; повідомлення — `showMsg`, `showConfirm`, `showPrompt` (проміси).
- Z-index: setupOverlay 2000 < sheetModal 2500 < повноекранні (таблиця, журнал, люди, імпорт, бекапи) 3000 <
  personModal 3500 < pwModal 3600 < msg/prompt/confirm 4000.

**Код**
- `escapeHtml()` для всього, що йде в HTML. PLU/ID з `data-*` — через `.attr()`, не `.data()`
  (jQuery робить з "0012" число 12).
- Кожна відповідь бази перевіряється на очікуване поле (`EXPECT` в api.js) — інакше вважається збоєм.
- ES5 у `web/js/*`: `var`, `function`, `.then` (без async/await і стрілок); у `sw.js` стрілки можна.
- Серверні приватні функції — з `_` у кінці. Виправлені баги — коментар `// ВИПРАВЛЕНО:` (зберігати традицію).
  Коментарі пояснюють *чому*.
- Нова SQL-міграція: файл `supabase/migrations/00N_*.sql`, ідемпотентний (повторний запуск не псує);
  `create or replace` + якщо змінюється сигнатура — `drop function if exists` стару; наприкінці
  `revoke all on all functions in schema public from public, anon, authenticated;` і `grant execute … to authenticated`
  на ВЕСЬ список api_* (Supabase за замовчуванням дає нові функції анонімові); у кінці файла — перевірочний `select`,
  результат якого власник побачить у SQL Editor. Тригер: `grant execute on function handle_new_user() to supabase_auth_admin`.
- Секретний ключ Supabase (`sb_secret_…`) ніколи не потрапляє в код чи репо.

## 6. Деплой і домен

- Cloudflare: Worker `sklad-terminal` на акаунті `ustymenko.yurii.s@gmail.com` (Account ID `60f4c306eadb348b0aa05a7418e03693`),
  static assets з `./web` (`wrangler.jsonc`, compatibility_date 2026-09-01). wrangler залогінений (OAuth).
- Деплой: з кореня `npx wrangler@4 deploy` → **перевірити адресу, яку друкує wrangler** (має бути
  `sklad-terminal.velocity-app.workers.dev`) → `curl -s "https://sklad-terminal.velocity-app.workers.dev/js/config.js?x=$RANDOM" | grep APP_VERSION`.
  Edge-кеш може кілька секунд віддавати старий файл — перевірити повторно.
- Власний домен не підключено (варіант на майбутнє, якщо адреса знову зміниться).
- Після зміни web/ завжди підняти `VERSION` у sw.js, інакше телефони довго показуватимуть стару версію
  (додаток сам пропонує «Nová verzia… Načítať teraz?»). Нові файли js додати в `SHELL_FILES` у sw.js.
- Supabase free: засинає після 7 днів без активності (відновлюється вручну до року), автоматичних бекапів немає.

## 7. Перевірка

- Синтаксис: `node --check web/js/*.js web/sw.js`.
- **SQL без бази власника:** `tools/tests/test003.mjs`, `test004.mjs` — PGlite (Postgres у WebAssembly) з імітацією
  `auth.users` / `auth.uid()`. Запуск: у тимчасовій папці `npm i @electric-sql/pglite`, скопіювати туди скрипт,
  поправити шлях `ROOT` до `supabase/migrations/`, `node test004.mjs` (і `with002`). Результат на v3.1.5: 74/74 і 27/27.
- **Інтерфейс:** `tools/tests/t314.js` (43 перевірки), `t315.js` (8), `t314imp.js` (імпорт, 8), `t316.js` (головна на ПК:
  власник, працівник, 1100 px, телефон; справжні кліки мишею — 79) — headless Chrome через CDP,
  запис у базу підмінено заглушками. Запуск: `python -m http.server 8765 --bind 127.0.0.1` у `web/`, потім
  `node t316.js "<chrome.exe>" "<тека профілю>" "http://127.0.0.1:8765/" "<тека скріншотів>"`
  (t314imp ще приймає шлях до XLSX). Можна і на живому URL. Скріншоти переглядати. Кожна заглушка важлива:
  не підмінений виклик іде в справжню базу без входу → 401 → програма виходить на екран входу.
  Тести чекають 3 с після відкриття сторінки — при повільному CDN можуть упасти всі разом; тоді повторити.
- **Розбір чисел імпорту без браузера:** `node tools/tests/t316num.js [шлях до xlsx.full.min.js]` — 34 перевірки
  (з бібліотекою ще й перевірка справжнім SheetJS 0.20.1: `https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js`).
- У Bash-heredoc `\n` і апострофи ламаються — довгі Python/JS-патчі писати у файл (Write) і запускати.

## 8. Що зроблено (коротко по версіях; деталі — PROGRESS.md)

- v3.0.1–v3.0.3: стабілізація Apps Script-версії (перевірка відповідей, кеш, вікно очікування) → відмова від GAS.
- v3.1.0: перенос на Supabase (31 529 позицій), скан-дельти з opId, Outbox без втрат, фокус сканера.
- v3.1.1: табличний редактор (Tabulator), єдиний дизайн і тексти.
- v3.1.2: одна таблиця товарів із замком, журнал як таблиця, компактний дизайн.
- v3.1.3: вхід e-mail+heslo, ролі, «Ľudia a prístupy», PIN прибрано.
- v3.1.4: іконки Lucide замість емодзі, стилізовані списки, дві форми входу, свій пароль, адмінка відкрита одразу,
  склади зі станами й карткою, історію стирає лише власник, нотатки в таблиці для всіх.
- v3.1.5: стилізований вибір камери, картка складу оновлюється після збереження таблиці.
- v3.1.6: головна на ПК на весь екран (меню як у Flex, таблиця складів, картка складу панеллю справа);
  імпорт — точні числа (план ≥ 1000) і коди-числа з Excel, «Plán spolu» у зведенні.

## 9. Далі (пріоритет згори; повний список — TODO.md)

1. Рішення власника: `Skladove_karty_Hayes_test.xlsx` (ціни) на публічному GitHub — прибрати з історії
   (force-push), зробити репо приватним чи лишити; щонайменше `git rm --cached` у наступному коміті.
2. Рішення власника: блокувати скани в «Dokončený» повністю чи лишити попередження.
3. Git-коміт v3.1.6 (запитати власника).
4. Відгук власника на нову головну на ПК (v3.1.6) — ідеї для продовження в TODO.
5. Відкрите питання власнику: яку колонку ERP брати як План («Disponibilný stav» зараз vs «Stav»/«Účtovný stav»).
6. Supabase не має засинати: щоденний cron-пінг (Cloudflare Worker); власні бекапи бази.
7. Запрошення без пароля — термін дії (напр. 7 днів); мінімальна довжина пароля 8 (за бажанням власника).
8. Журнал: фільтр за людиною; у таблиці — хто/коли востаннє змінив рядок.
9. Камера: формати EAN, широка рамка, скан підряд; DUPLIKÁT — вибір зі збігів замість блокування.
10. Прибирання: невикористані CSS (`uni-*`, `ac-*`), мертвий код (`#conflictBanner`, режим backup), `gas/` і файли v2
    з кореня → архів, новий README; старі логи з Google Таблиці (за потреби).
11. Колись: злити акаунти з Flex Bike Analytics (спільний Supabase, спільні `profiles`).
