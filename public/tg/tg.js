/* Mini App «Журналки». Пустой initData — экран без запросов к API. */
(function () {
  "use strict";
  var ZJ = window.ZJ;
  var h = ZJ.h;
  ZJ.tg = true;
  document.documentElement.setAttribute("data-tg", "1");
  var light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  document.documentElement.setAttribute("data-theme", light ? "light" : "dark");

  var tg = window.Telegram && window.Telegram.WebApp;
  var bot = (window.ZJ_PUBLIC && window.ZJ_PUBLIC.bot) || "trio_zhurnalka_bot";

  function screen(title, nodes) {
    ZJ.mount(h("main", { class: "page narrow" }, h("h1", { text: title }), nodes));
  }

  function openOutside() {
    screen("Откройте в Telegram", [
      h("p", { class: "muted", text: "Кабинет в Telegram открывается только из бота." }),
      h("a", { class: "btn primary wide", href: "https://t.me/" + bot + "/app", text: "Открыть бота" }),
      h("a", { class: "btn wide", href: "/app/", text: "Войти на сайте" })
    ]);
  }

  if (!tg || !tg.initData) {
    openOutside();
    return;
  }

  try { tg.ready(); tg.expand(); } catch (e) {}
  applyTheme(tg);
  applyViewport(tg);
  if (tg.onEvent) {
    tg.onEvent("themeChanged", function () { applyTheme(tg); });
    tg.onEvent("viewportChanged", function () { applyViewport(tg); });
    tg.onEvent("safeAreaChanged", function () { applyViewport(tg); });
    tg.onEvent("contentSafeAreaChanged", function () { applyViewport(tg); });
  }
  if (tg.BackButton) {
    tg.BackButton.onClick(function () { history.back(); });
    window.addEventListener("hashchange", syncBack);
  }
  document.addEventListener("input", function (e) {
    if (e.target && e.target.form && tg.enableClosingConfirmation) tg.enableClosingConfirmation();
  }, true);
  document.addEventListener("submit", function () {
    if (tg.disableClosingConfirmation) tg.disableClosingConfirmation();
  }, true);
  if (window.MutationObserver && tg.disableVerticalSwipes) {
    new MutationObserver(function () {
      if (document.querySelector(".table, .table-box, .doc")) tg.disableVerticalSwipes();
    }).observe(document.body, { childList: true, subtree: true });
  }

  var start = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || param("tgWebAppStartParam") || "";

  function param(name) {
    var q = location.search.replace(/^\?/, "").split("&");
    for (var i = 0; i < q.length; i++) {
      var p = q[i].split("=");
      if (decodeURIComponent(p[0] || "") === name) return decodeURIComponent(p[1] || "");
    }
    return "";
  }

  function deviceId() {
    var KEY = "zj_device";
    return new Promise(function (resolve) {
      function fresh() {
        var bytes = new Uint8Array(16);
        (window.crypto || window.msCrypto).getRandomValues(bytes);
        var s = "";
        for (var i = 0; i < bytes.length; i++) s += (bytes[i] + 256).toString(16).slice(1);
        return s;
      }
      if (tg.SecureStorage && tg.SecureStorage.getItem) {
        tg.SecureStorage.getItem(KEY, function (err, v) {
          if (v) return resolve(v);
          var n = fresh();
          tg.SecureStorage.setItem(KEY, n, function () { resolve(n); });
        });
        return;
      }
      if (tg.DeviceStorage && tg.DeviceStorage.getItem) {
        tg.DeviceStorage.getItem(KEY, function (err, v) {
          if (v) return resolve(v);
          var n = fresh();
          tg.DeviceStorage.setItem(KEY, n, function () { resolve(n); });
        });
        return;
      }
      try {
        var v = localStorage.getItem(KEY);
        if (!v) { v = fresh(); localStorage.setItem(KEY, v); }
        resolve(v);
      } catch (e) { resolve(fresh()); }
    });
  }

  function payload(id) {
    return { initData: tg.initData, device_id: id, platform: tg.platform || "", device_label: (tg.platform || "Telegram") + " · Telegram" };
  }

  function auth(id) {
    return ZJ.apiAuth("/api/tg/auth", payload(id));
  }

  ZJ.tgRenew = function () {
    return deviceId().then(auth).then(function (d) {
      if (d && d.token) { ZJ.acceptAuth(d); remember(d.token); return d; }
      if (d && d.error === "EXPIRED") { ZJ.tgShowRenew(); var e = new Error("EXPIRED"); e.hint = "expired"; throw e; }
      if (d && d.need_link) { showEntry(d); var e2 = new Error("need_link"); e2.hint = "auth"; throw e2; }
      return d;
    });
  };

  ZJ.tgShowRenew = function () {
    screen("Обновите приложение", [
      h("p", { class: "muted", text: "Кабинет был открыт слишком долго. Закройте его и откройте снова — пароль не понадобится." }),
      h("button", { class: "btn primary wide", type: "button", text: "Закрыть", onclick: function () { if (tg.close) tg.close(); } })
    ]);
  };

  ZJ.tgReset = function () { showEntry({ need_link: true, tg: {} }); };

  function remember(token) {
    if (tg.SecureStorage && tg.SecureStorage.setItem && token) tg.SecureStorage.setItem("zj_at", token, function () {});
  }

  function showEntry(d) {
    if (start.indexOf("l_") === 0) consent(start.slice(2), d);
    else password(d);
  }

  function consentBox(onOk) {
    var box = h("label", { class: "check" });
    var input = h("input", { type: "checkbox" });
    var btn = h("button", { class: "btn primary wide", type: "button", text: "Привязать", disabled: true });
    input.addEventListener("change", function () { btn.disabled = !input.checked; });
    box.appendChild(input);
    box.appendChild(h("span", null, "Согласен на обработку моего Telegram ID, имени и username для входа без пароля. ",
      h("a", { href: "/legal/privacy.html", text: "Политика", onclick: function (ev) { ev.preventDefault(); ZJ.openExternal(location.origin + "/legal/privacy.html"); } })));
    btn.addEventListener("click", function () { if (input.checked) onOk(btn); });
    return { box: box, btn: btn, input: input };
  }

  function consent(code, d) {
    var c = consentBox(function (btn) {
      btn.disabled = true;
      deviceId().then(function (id) {
        var body = payload(id);
        body.code = code;
        body.consent = true;
        return ZJ.apiAuth("/api/tg/link", body);
      }).then(function (r) {
        ZJ.acceptAuth(r); remember(r.token); ZJ.release(); ZJ.go("/o");
      }, function (e) {
        btn.disabled = false;
        if (e.body && e.message === "EXPIRED" || e.message === "EXPIRED") ZJ.tgShowRenew();
        else ZJ.toast(e.message || "Не удалось привязать", "bad");
      });
    });
    var name = d && d.tg && d.tg.first_name ? d.tg.first_name : "";
    screen("Привязать Telegram", [
      h("p", { class: "muted", text: name ? (name + ", подтвердите вход в кабинет.") : "Подтвердите вход в кабинет." }),
      c.box, c.btn
    ]);
  }

  function password() {
    var email = h("input", { type: "email", autocomplete: "username", required: true });
    var pass = h("input", { type: "password", autocomplete: "current-password", required: true });
    var c = consentBox(function () {});
    var err = h("p", { class: "form-err", role: "alert" });
    var btn = h("button", { class: "btn primary wide", type: "submit", text: "Войти", disabled: true });
    c.input.addEventListener("change", function () { btn.disabled = !c.input.checked; });
    var form = h("form", { class: "card form", onsubmit: function (ev) {
      ev.preventDefault();
      if (!c.input.checked) return;
      err.textContent = ""; btn.disabled = true;
      deviceId().then(function (id) {
        var body = payload(id);
        body.email = email.value; body.password = pass.value; body.consent = true;
        return ZJ.apiAuth("/api/tg/login", body);
      }).then(function (r) {
        ZJ.acceptAuth(r); remember(r.token); ZJ.release(); ZJ.go("/o");
      }, function (e) {
        btn.disabled = !c.input.checked;
        err.textContent = e.message === "REPLAY" ? "Откройте кабинет ещё раз" : (e.message || "Не удалось войти");
      });
    } },
      h("h1", { text: "Вход" }),
      h("p", { class: "muted small", text: "Проще: на сайте в Настройках нажмите «Привязать Telegram»." }),
      h("label", null, "Почта", email),
      h("label", null, "Пароль", pass),
      c.box, err, btn,
      h("p", { class: "small muted center" }, h("button", { class: "btn ghost small", type: "button", text: "Нет аккаунта? Зарегистрироваться на сайте", onclick: function () {
        ZJ.openExternal(location.origin + "/app/#/register");
      } })));
    ZJ.mount(h("main", { class: "page narrow" }, form));
  }

  function syncBack() {
    if (!tg.BackButton) return;
    var path = ZJ.path();
    if (path === "/o" || path === "/") tg.BackButton.hide();
    else tg.BackButton.show();
  }

  function applyTheme(app) {
    var p = app.themeParams || {};
    var root = document.documentElement;
    var dark = app.colorScheme !== "light";
    root.setAttribute("data-theme", dark ? "dark" : "light");
    var map = { "--bg": p.bg_color, "--surface": p.secondary_bg_color, "--ink": p.text_color, "--muted": p.hint_color, "--accent": p.button_color, "--line": p.section_separator_color };
    Object.keys(map).forEach(function (k) { if (map[k]) root.style.setProperty(k, map[k]); });
    try {
      if (app.setHeaderColor && (p.bg_color || p.header_bg_color)) app.setHeaderColor(p.header_bg_color || p.bg_color);
      if (app.setBackgroundColor && p.bg_color) app.setBackgroundColor(p.bg_color);
    } catch (e) {}
  }

  function applyViewport(app) {
    var root = document.documentElement;
    var vh = app.viewportStableHeight || app.viewportHeight;
    if (vh) root.style.setProperty("--tg-viewport-stable-height", vh + "px");
    function put(prefix, box) {
      if (!box) return;
      ["top", "right", "bottom", "left"].forEach(function (side) {
        if (box[side] != null) root.style.setProperty("--tg-" + prefix + "-inset-" + side, box[side] + "px");
      });
    }
    put("safe-area", app.safeAreaInset);
    put("content-safe-area", app.contentSafeAreaInset);
  }

  deviceId().then(auth).then(function (d) {
    if (d && d.token) { ZJ.acceptAuth(d); remember(d.token); ZJ.release(); syncBack(); return; }
    if (d && d.need_link) { showEntry(d); return; }
    if (d && d.error === "EXPIRED") { ZJ.tgShowRenew(); return; }
    showEntry(d || {});
  }, function (e) {
    if (e && e.message === "EXPIRED") ZJ.tgShowRenew();
    else showEntry({});
  });
})();
