/**
 * AUTH.JS — вхід за e-mailом і паролем (Supabase Auth) і ролі.
 * Остання зміна: v3.1.4 (див. PROGRESS.md у корені репо)
 *
 * v3.1.3: замість спільного адмін-PIN кожна людина має свій акаунт.
 * Та сама схема, що у Flex Bike Analytics (profiles + invites, ролі
 * owner/admin/member) — щоб колись злити акаунти обох програм за e-mailом.
 *
 * ЧОМУ БІБЛІОТЕКА supabase-js, А НЕ ВЛАСНИЙ fetch: токен входу живе годину і
 * його треба вчасно оновлювати. Якщо відкриті дві вкладки (звично для ПК на
 * складі), вони можуть оновити той самий токен одночасно — Supabase сприймає це
 * як крадіжку й розлогінює людину посеред інвентури. Бібліотека домовляється
 * між вкладками сама. Для запитів до бази (api.js) звідси береться лише токен.
 *
 * Що кому можна, остаточно вирішує БАЗА (003_accounts_roles.sql). Тут ролі
 * потрібні лише для того, щоб не показувати кнопок, яких людині однаково не
 * дозволять.
 */
(function (global) {
  'use strict';

  var CFG = global.APP_CONFIG;
  var STORAGE_KEY = 'sklad-auth';     // сесія (пише supabase-js)
  var ME_KEY = 'termMe_v1';           // профіль: ім'я і роль — щоб екран був миттєво

  var ROLE_LABEL = { owner: 'Vlastník', admin: 'Správca', member: 'Pracovník' };
  var ROLE_NOTE = {
    owner:  'Môže všetko vrátane správy ďalších vlastníkov.',
    admin:  'Všetko okrem vlastníkov a mazania histórie: sklady, import, úpravy tabuľky, zálohy, ľudia.',
    member: 'Inventúra: skenovanie, ručné +/−, poznámky, prehľad, zoznam a história skladu.'
  };
  var RANK = { owner: 3, admin: 2, member: 1 };

  var sb = null;
  var session = null;
  var me = null;

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  /** Збережена сесія без звернення до мережі (для миттєвого старту і keepalive). */
  function storedSession() {
    var s = readJson(STORAGE_KEY);
    return (s && s.access_token && s.user) ? s : null;
  }

  function client() {
    if (sb) return sb;
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      throw new Error('Knižnica prihlásenia sa nenačítala. Skontrolujte internet a obnovte stránku.');
    }
    sb = global.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: STORAGE_KEY }
    });
    sb.auth.onAuthStateChange(function (event, s) {
      session = s || null;
      // Бібліотека забороняє викликати себе зсередини цього обробника (зависання),
      // тому реакцію програми відкладаємо.
      if (event === 'SIGNED_OUT') {
        setMe(null);
        setTimeout(function () { if (typeof global.onSignedOut === 'function') global.onSignedOut(); }, 0);
      }
    });
    return sb;
  }

  function setMe(p) {
    me = p || null;
    try {
      if (me) localStorage.setItem(ME_KEY, JSON.stringify(me));
      else localStorage.removeItem(ME_KEY);
    } catch (e) {}
  }

  /**
   * Старт без очікування мережі: якщо на пристрої є сесія — людина вважається
   * увійшла одразу (ім'я й роль з минулого разу), а база підтвердить або
   * відхилить це першим же запитом. Повертає true, якщо сесія є.
   */
  function start() {
    try { client(); } catch (e) { return false; }
    var s = storedSession();
    if (!s) { setMe(null); return false; }
    session = s;
    var cached = readJson(ME_KEY);
    me = (cached && cached.id === s.user.id) ? cached : null;
    return true;
  }

  function isRetryable(err) {
    return !!err && (err.name === 'AuthRetryableFetchError' || !err.status || err.status >= 500);
  }

  /**
   * Свіжий токен для запиту. Прострочений бібліотека оновить сама.
   * Немає інтернету, а токен прострочений — це тимчасова помилка (запис піде в
   * чергу), а НЕ «вихід»: інакше людина губила б вхід при кожному обриві Wi-Fi.
   */
  function token() {
    var c;
    try { c = client(); } catch (e) { return Promise.reject(e); }
    return c.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s) { session = s; return s.access_token; }
      if (r && r.error && isRetryable(r.error)) {
        var t = new Error('Nie je spojenie so serverom.');
        t.transient = true;
        throw t;
      }
      return null;
    });
  }

  /** Токен без очікування — для відправки при закритті вкладки. */
  function tokenSync() {
    var s = session || storedSession();
    return s ? s.access_token : null;
  }

  /**
   * База відповіла «токен недійсний» (401). Пробуємо оновити один раз.
   * Повертає true — можна повторити запит; false — вхід справді втрачено.
   */
  function refresh() {
    return client().auth.refreshSession().then(function (r) {
      if (r && r.data && r.data.session) { session = r.data.session; return true; }
      if (r && r.error && isRetryable(r.error)) {
        var t = new Error('Nie je spojenie so serverom.');
        t.transient = true;
        throw t;
      }
      return false;
    });
  }

  // ------------------------------------------------------------ помилки людською мовою

  /**
   * Supabase відповідає англійською й технічно. Кожну часту відповідь
   * перекладаємо в те, що з нею робити (перелік — з досвіду Flex).
   */
  function niceError(err, email) {
    var raw = String((err && (err.message || err.msg || err.error_description)) || err || '');
    var code = String((err && (err.code || err.error_code)) || '');
    var m = (raw + ' ' + code).toLowerCase();

    if (m.indexOf('invalid login credentials') !== -1 || m.indexOf('invalid_credentials') !== -1)
      return 'Nesprávny e-mail alebo heslo.';
    if (m.indexOf('email not confirmed') !== -1 || m.indexOf('email_not_confirmed') !== -1)
      return 'E-mail nie je potvrdený. Správca musí v Supabase vypnúť „Confirm email“ (Authentication → Sign In / Providers → Email).';
    if (m.indexOf('already registered') !== -1 || m.indexOf('already been registered') !== -1 || m.indexOf('user_already_exists') !== -1)
      return 'Na tento e-mail už účet existuje. Prihláste sa heslom — ak ho nepoznáte, správca vám nastaví nové.';
    if (m.indexOf('database error saving new user') !== -1 || m.indexOf('pozvánku') !== -1 || m.indexOf('unexpected_failure') !== -1)
      return 'E-mail ' + (email ? email + ' ' : '') + 'nemá pozvánku. Správca vás musí najprv pridať (Administrácia → Ľudia a prístupy) — presne s touto adresou.';
    if (m.indexOf('password should be') !== -1 || m.indexOf('weak_password') !== -1 || m.indexOf('weak password') !== -1)
      return 'Heslo je príliš slabé. Použite aspoň 6 znakov.';
    if (m.indexOf('same_password') !== -1 || m.indexOf('should be different') !== -1)
      return 'Nové heslo musí byť iné ako doterajšie.';
    if (m.indexOf('reauthentication') !== -1)
      return 'Z bezpečnostných dôvodov sa odhláste, znova prihláste a potom heslo zmeňte.';
    if (m.indexOf('signup') !== -1 && (m.indexOf('disabled') !== -1 || m.indexOf('not allowed') !== -1))
      return 'Registrácia je v Supabase vypnutá. Správca musí zapnúť „Allow new users to sign up“.';
    if (m.indexOf('email_address_invalid') !== -1 || (m.indexOf('email address') !== -1 && m.indexOf('invalid') !== -1))
      return 'Supabase tento e-mail neprijal. Použite skutočnú e-mailovú adresu.';
    if (m.indexOf('rate limit') !== -1 || m.indexOf('too many') !== -1 || m.indexOf('over_request_rate_limit') !== -1)
      return 'Priveľa pokusov za sebou. Počkajte minútu a skúste znova.';
    if (m.indexOf('failed to fetch') !== -1 || m.indexOf('network') !== -1 || m.indexOf('fetch') !== -1)
      return 'Nie je spojenie so serverom. Skontrolujte internet.';
    return raw || 'Neznáma chyba prihlásenia.';
  }

  function fail(err, email) {
    var e = new Error(niceError(err, email));
    e.raw = err;
    return e;
  }

  // ------------------------------------------------------------ дії

  function signIn(email, password) {
    email = String(email || '').trim().toLowerCase();
    return client().auth.signInWithPassword({ email: email, password: password }).then(function (r) {
      if (r.error) throw fail(r.error, email);
      session = r.data.session;
      if (me && session && me.id !== session.user.id) setMe(null);
      return session;
    });
  }

  /** Перший вхід запрошеної людини: сама задає собі пароль. */
  function signUp(email, password) {
    email = String(email || '').trim().toLowerCase();
    return client().auth.signUp({ email: email, password: password }).then(function (r) {
      if (r.error) throw fail(r.error, email);
      if (!r.data || !r.data.session) {
        throw new Error('Účet je vytvorený, ale Supabase čaká na potvrdenie e-mailu. Správca musí vypnúť „Confirm email“ ' +
                        '(Authentication → Sign In / Providers → Email) — potom sa prihláste.');
      }
      session = r.data.session;
      setMe(null);
      return session;
    });
  }

  /**
   * Správca заводить акаунт ІНШІЙ людині з паролем. Окремий виклик без
   * бібліотеки — інакше бібліотека «увійшла» б новою людиною замість správcu.
   * Запрошення перед цим уже створене (api_invite_save), тож база реєстрацію пропустить.
   */
  function createAccount(email, password, name) {
    email = String(email || '').trim().toLowerCase();
    return fetch(CFG.SUPABASE_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'apikey': CFG.SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password, data: { full_name: name || '' } })
    }).then(function (res) {
      return res.text().then(function (text) {
        var d = {};
        try { d = text ? JSON.parse(text) : {}; } catch (e) {}
        if (!res.ok) throw fail({ message: d.msg || d.message || d.error_description || d.error || ('HTTP ' + res.status),
                                  code: d.error_code || d.code, status: res.status }, email);
        var access = d.access_token || (d.session && d.session.access_token);
        if (!access) {
          throw new Error('Účet je vytvorený, ale Supabase čaká na potvrdenie e-mailu. Vypnite „Confirm email“ ' +
                          '(Authentication → Sign In / Providers → Email) — potom sa človek prihlási.');
        }
        // сесія нової людини нам не потрібна — закриваємо її одразу
        fetch(CFG.SUPABASE_URL + '/auth/v1/logout', {
          method: 'POST', headers: { 'apikey': CFG.SUPABASE_KEY, 'Authorization': 'Bearer ' + access }
        }).catch(function () {});
        return true;
      });
    }, function (e) { throw fail(e, email); });
  }

  function changePassword(password) {
    return client().auth.updateUser({ password: password }).then(function (r) {
      if (r.error) throw fail(r.error);
      return true;
    });
  }

  /**
   * Вихід лише на ЦЬОМУ пристрої. Якщо сервер недоступний, бібліотека лишила б
   * сесію — тоді прибираємо її з пристрою самі: «Odhlásiť» має спрацювати завжди.
   */
  function signOut() {
    setMe(null);
    var done = function () {
      session = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    };
    var c;
    try { c = client(); } catch (e) { done(); return Promise.resolve(); }
    return c.auth.signOut({ scope: 'local' }).then(done, done);
  }

  // ------------------------------------------------------------ ролі

  function can(minRole) { return !!me && (RANK[me.role] || 0) >= (RANK[minRole] || 99); }

  function initials(name) {
    var parts = String(name || '?').trim().split(/[\s.@_-]+/).filter(Boolean);
    var take = parts.length >= 2 ? [parts[0], parts[1]] : [parts[0] || '?'];
    return take.map(function (p) { return p.charAt(0); }).join('').toUpperCase().slice(0, 2);
  }

  global.Auth = {
    ROLE_LABEL: ROLE_LABEL,
    ROLE_NOTE: ROLE_NOTE,
    start: start,
    token: token,
    tokenSync: tokenSync,
    refresh: refresh,
    signIn: signIn,
    signUp: signUp,
    createAccount: createAccount,
    changePassword: changePassword,
    signOut: signOut,
    niceError: niceError,
    me: function () { return me; },
    setMe: setMe,
    userId: function () { var s = session || storedSession(); return s && s.user ? s.user.id : null; },
    can: can,
    roleLabel: function (r) { return ROLE_LABEL[r] || r || ''; },
    initials: initials
  };

})(window);
