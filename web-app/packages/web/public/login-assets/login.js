// Login page (new - the original application had no authentication). With `auth.mode: local`
// the server also offers registration; the same form switches between the two.
(function () {
  var MESSAGES = {
    invalid_credentials: 'Nesprávne používateľské meno alebo heslo.',
    not_authorized: 'Nemáte oprávnenie na použitie aplikácie.',
    directory_unavailable: 'Adresárová služba nie je dostupná. Skúste to neskôr.',
    rate_limited: 'Príliš veľa pokusov. Skúste to neskôr.',
    username_taken: 'Používateľské meno je už obsadené.',
    invalid_username: 'Neplatné používateľské meno (3–32 znakov: písmená, číslice, bodka, podčiarkovník, pomlčka).',
    weak_password: 'Heslo musí mať aspoň 8 znakov.',
    password_mismatch: 'Heslá sa nezhodujú.',
    unavailable: 'Server nie je dostupný. Skúste to neskôr.'
  };
  var $ = function (id) { return document.getElementById(id); };
  var form = $('login'), user = $('username'), pass = $('password'), pass2 = $('password2');
  var btn = $('submit'), err = $('error');
  var registering = false;
  var ldap = false;

  function updateLabel() {
    // LDAP users may log in with their account name or e-mail; registration is local-only
    $('username-label').textContent = ldap && !registering ? 'Používateľské meno alebo e-mail' : 'Používateľské meno';
  }

  function update() {
    var filled = user.value.trim() !== '' && pass.value !== '' && (!registering || pass2.value !== '');
    btn.disabled = !filled;
  }
  [user, pass, pass2].forEach(function (el) { el.addEventListener('input', update); });

  function setMode(register) {
    registering = register;
    $('heading').textContent = register ? 'CPU Emulator - registrácia' : 'CPU Emulator';
    document.title = register ? 'CPU Emulator - registrácia' : 'CPU Emulator - prihlásenie';
    $('password2-row').hidden = !register;
    $('username-hint').hidden = !register;
    $('password-hint').hidden = !register;
    pass.autocomplete = register ? 'new-password' : 'current-password';
    btn.textContent = register ? 'Zaregistrovať' : 'Prihlásiť';
    $('switch-text').textContent = register ? 'Máte účet?' : 'Nemáte účet?';
    $('switch-link').textContent = register ? 'Prihlásiť sa' : 'Zaregistrovať sa';
    err.hidden = true;
    pass2.value = '';
    updateLabel();
    update();
    user.focus();
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
    update();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (btn.disabled) return;
    if (registering && pass.value !== pass2.value) return fail('password_mismatch');
    err.hidden = true;
    btn.disabled = true;
    fetch(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cpuemul' },
      body: JSON.stringify({ username: user.value.trim(), password: pass.value })
    }).then(function (res) {
      if (res.ok) { window.location.replace('/'); return; }
      return res.json().catch(function () { return {}; }).then(function (body) {
        fail((body && body.error) || (res.status === 429 ? 'rate_limited' : 'invalid_credentials'));
      });
    }).catch(function () {
      fail(registering ? 'unavailable' : 'directory_unavailable');
    });
  });
})();
