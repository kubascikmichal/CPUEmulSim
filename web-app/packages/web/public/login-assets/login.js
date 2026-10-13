// Login page (new - the original application had no authentication). With `auth.mode: local`
// the server also offers registration; the same form switches between the two. Registration asks
// for the full name and is protected by a proof-of-work captcha (ALTCHA protocol, solved here).
(function () {
  var MESSAGES = {
    invalid_credentials: 'Nesprávne používateľské meno alebo heslo.',
    not_authorized: 'Nemáte oprávnenie na použitie aplikácie.',
    account_disabled: 'Účet je zablokovaný. Obráťte sa na vyučujúceho.',
    directory_unavailable: 'Adresárová služba nie je dostupná. Skúste to neskôr.',
    rate_limited: 'Príliš veľa pokusov. Skúste to neskôr.',
    username_taken: 'Používateľské meno je už obsadené.',
    invalid_username: 'Neplatné používateľské meno (3–32 znakov: písmená, číslice, bodka, podčiarkovník, pomlčka).',
    invalid_name: 'Zadajte meno a priezvisko (najviac 100 znakov).',
    weak_password: 'Heslo musí mať aspoň 8 znakov.',
    password_mismatch: 'Heslá sa nezhodujú.',
    captcha_failed: 'Overenie zlyhalo. Označte znova „Nie som robot“.',
    unavailable: 'Server nie je dostupný. Skúste to neskôr.'
  };
  var $ = function (id) { return document.getElementById(id); };
  var form = $('login'), user = $('username'), pass = $('password'), pass2 = $('password2'), fullName = $('name');
  var btn = $('submit'), err = $('error');
  var captchaCheck = $('captcha-check'), captchaText = $('captcha-text');
  var registering = false;
  var ldap = false;
  var captchaEnabled = false;
  /** Solved captcha payload (base64) for the next registration, or null. */
  var captchaPayload = null;
  var captchaRun = 0;

  function updateLabel() {
    // LDAP users may log in with their account name or e-mail; registration is local-only
    $('username-label').textContent = ldap && !registering ? 'Používateľské meno alebo e-mail' : 'Používateľské meno';
  }

  function update() {
    var filled = user.value.trim() !== '' && pass.value !== '' &&
      (!registering || (pass2.value !== '' && fullName.value.trim() !== '' && (!captchaEnabled || captchaPayload !== null)));
    btn.disabled = !filled;
  }
  [user, pass, pass2, fullName].forEach(function (el) { el.addEventListener('input', update); });

  // ---- captcha ------------------------------------------------------------------------------

  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /** Finds n in 0..maxnumber with SHA-256(salt + n) = challenge (in batches, keeps the page responsive). */
  async function solve(c, run) {
    var enc = new TextEncoder();
    for (var start = 0; start <= c.maxnumber; start += 1000) {
      if (run !== captchaRun) return null;
      var end = Math.min(start + 1000, c.maxnumber + 1);
      var batch = [];
      for (var n = start; n < end; n++) batch.push(crypto.subtle.digest('SHA-256', enc.encode(c.salt + n)));
      var hashes = await Promise.all(batch);
      for (var i = 0; i < hashes.length; i++) if (hex(hashes[i]) === c.challenge) return start + i;
    }
    return null;
  }

  function setCaptchaState(state) {
    $('captcha-row').classList.toggle('done', state === 'done');
    captchaCheck.checked = state === 'done' || state === 'working';
    captchaCheck.disabled = state === 'working' || state === 'done';
    captchaText.textContent = state === 'working' ? 'Overujem…' : state === 'done' ? 'Overené' : state === 'insecure'
      ? 'Overenie vyžaduje zabezpečené pripojenie (HTTPS).' : state === 'error' ? 'Overenie zlyhalo - skúste znova' : 'Nie som robot';
  }

  function resetCaptcha() {
    captchaRun++;
    captchaPayload = null;
    setCaptchaState('idle');
    update();
  }

  captchaCheck.addEventListener('change', function () {
    if (!captchaCheck.checked || captchaPayload !== null) return;
    if (!window.crypto || !crypto.subtle) { setCaptchaState('insecure'); captchaCheck.checked = false; return; }
    var run = ++captchaRun;
    setCaptchaState('working');
    fetch('/api/auth/captcha', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('captcha'); return res.json(); })
      .then(function (c) {
        return solve(c, run).then(function (number) {
          if (run !== captchaRun) return;
          if (number === null) throw new Error('unsolved');
          captchaPayload = btoa(JSON.stringify({ algorithm: c.algorithm, challenge: c.challenge, number: number, salt: c.salt, signature: c.signature }));
          setCaptchaState('done');
          update();
        });
      })
      .catch(function () {
        if (run !== captchaRun) return;
        setCaptchaState('error');
        update();
      });
  });

  // ---- form modes ---------------------------------------------------------------------------

  function setMode(register) {
    registering = register;
    $('heading').textContent = register ? 'CPU Emulator - registrácia' : 'CPU Emulator';
    document.title = register ? 'CPU Emulator - registrácia' : 'CPU Emulator - prihlásenie';
    $('name-row').hidden = !register;
    $('password2-row').hidden = !register;
    $('username-hint').hidden = !register;
    $('password-hint').hidden = !register;
    $('captcha-row').hidden = !(register && captchaEnabled);
    pass.autocomplete = register ? 'new-password' : 'current-password';
    btn.textContent = register ? 'Zaregistrovať' : 'Prihlásiť';
    $('switch-text').textContent = register ? 'Máte účet?' : 'Nemáte účet?';
    $('switch-link').textContent = register ? 'Prihlásiť sa' : 'Zaregistrovať sa';
    err.hidden = true;
    pass2.value = '';
    updateLabel();
    update();
    (register ? fullName : user).focus();
  }

  $('switch-link').addEventListener('click', function (e) {
    e.preventDefault();
    setMode(!registering);
  });

  // registration is offered only when the server allows it (auth.mode: local)
  fetch('/api/auth/config', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : {}; })
    .then(function (cfg) {
      ldap = !!(cfg && cfg.ldap);
      captchaEnabled = !!(cfg && cfg.captcha);
      updateLabel();
      if (cfg && cfg.registration) {
        $('switch').hidden = false;
        if (window.location.hash === '#register') setMode(true);
      }
    })
    .catch(function () { /* login only */ });

  function fail(code) {
    err.textContent = MESSAGES[code] || MESSAGES.invalid_credentials;
    err.hidden = false;
    // a captcha solution is accepted only once - a failed registration needs a new one
    if (registering && captchaEnabled) resetCaptcha();
    update();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (btn.disabled) return;
    if (registering && pass.value !== pass2.value) {
      err.textContent = MESSAGES.password_mismatch;
      err.hidden = false;
      return;
    }
    err.hidden = true;
    btn.disabled = true;
    var body = registering
      ? { username: user.value.trim(), password: pass.value, name: fullName.value.trim(), captcha: captchaPayload }
      : { username: user.value.trim(), password: pass.value };
    fetch(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cpuemul' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.ok) { window.location.replace('/'); return; }
      return res.json().catch(function () { return {}; }).then(function (data) {
        fail((data && data.error) || (res.status === 429 ? 'rate_limited' : 'invalid_credentials'));
      });
    }).catch(function () {
      fail(registering ? 'unavailable' : 'directory_unavailable');
    });
  });
})();
