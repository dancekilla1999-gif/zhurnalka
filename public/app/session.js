/* Сессия кабинета: access только в памяти, refresh только в cookie. Токены в localStorage не пишем. */
(function () {
  "use strict";
  var ZJ = window.ZJ;
  var access = null;
  var profile = null;
  var renewing = null;

  var hash = location.hash || "";
  var inv = hash.match(/[?&]invite=([A-Za-z0-9_-]+)/);
  if (inv) {
    ZJ.pendingInvite = inv[1];
    try { history.replaceState(null, "", location.pathname + location.search + "#/register"); }
    catch (e) { location.hash = "#/register"; }
  }

  ZJ.accessToken = function () { return access; };
  ZJ.profile = function () { return profile; };
  ZJ.setProfile = function (o) { profile = o ? { email: o.email || "", name: o.name || "" } : null; };
  ZJ.acceptAuth = function (r) {
    access = r && r.token ? r.token : null;
    if (r) ZJ.setProfile(r);
    if (r && r.plan) ZJ.mePlan = r.plan;
  };
  ZJ.clearAuth = function () { access = null; profile = null; };

  function apiAuth(path, body, method) {
    var headers = { "Content-Type": "application/json" };
    if (access) headers.Authorization = "Bearer " + access;
    return fetch(path, {
      method: method || "POST",
      credentials: "same-origin",
      headers: headers,
      body: method === "GET" ? undefined : JSON.stringify(body || {})
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e2) { data = null; }
        if (!r.ok) {
          var err = new Error((data && (data.error || data.message)) || "Ошибка");
          err.hint = data && data.hint;
          err.status = r.status;
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error("Нет связи с сервером. Проверьте интернет");
      err.network = true;
      throw err;
    });
  }
  ZJ.apiAuth = apiAuth;

  var rawDispatch = ZJ.dispatch;
  var hold = true;
  ZJ.dispatch = function () { if (!hold) rawDispatch(); };
  ZJ.release = function () { hold = false; rawDispatch(); };

  function refresh() {
    return apiAuth("/api/auth/refresh", {}).then(function (d) { ZJ.acceptAuth(d); return d; });
  }

  function migrate() {
    var raw = null;
    try { raw = localStorage.getItem("zj_owner"); } catch (e) { raw = null; }
    if (!raw) return Promise.resolve(false);
    var o = null;
    try { o = JSON.parse(raw); } catch (e2) { o = null; }
    try { localStorage.removeItem("zj_owner"); } catch (e3) {}
    if (!o || !o.token) return Promise.resolve(false);
    return apiAuth("/api/auth/migrate", { token: o.token }).then(function (d) {
      ZJ.acceptAuth(d);
      return true;
    }, function () { return false; });
  }

  ZJ.silentRenew = function () {
    if (ZJ.tg && ZJ.tgRenew) return ZJ.tgRenew();
    if (renewing) return renewing;
    renewing = refresh().then(function (d) { renewing = null; return d; }, function (e) { renewing = null; throw e; });
    return renewing;
  };

  var banner = null;
  ZJ.offline = function () {
    if (!banner) {
      banner = ZJ.h("div", { class: "net-banner", role: "status", text: "Нет связи" });
      document.body.appendChild(banner);
    }
    banner.className = "net-banner show";
  };

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function callOnce(fn, args) {
    return ZJ.api(fn, Object.assign({ p_token: access }, args || {})).then(function (data) {
      if (fn === "zh_me" && data) {
        ZJ.mePlan = data.plan || ZJ.mePlan;
        if (data.email) ZJ.setProfile(data);
        ZJ.tgLinkInfo = data.tg || null;
      }
      return data;
    });
  }

  ZJ.authedCall = function (fn, args, retried, attempt) {
    var n = attempt || 0;
    return callOnce(fn, args).catch(function (e) {
      if (e.network || (e.status && e.status >= 500)) {
        ZJ.offline();
        if (n < 3) return wait(400 * Math.pow(2, n)).then(function () { return ZJ.authedCall(fn, args, retried, n + 1); });
        throw e;
      }
      if (e.hint === "expired" && !retried) {
        return ZJ.silentRenew().then(function () { return ZJ.authedCall(fn, args, true, 0); });
      }
      if (e.hint === "disabled") { ZJ.showDisabled(); throw e; }
      if ((e.hint === "revoked" || e.hint === "auth") && ZJ.tg && ZJ.tgRenew && !retried) {
        return ZJ.tgRenew().then(function (d) {
          if (d && d.token) return ZJ.authedCall(fn, args, true, 0);
          throw e;
        });
      }
      if (e.hint === "revoked" || e.hint === "auth") {
        if (!ZJ.tg) { ZJ.clearAuth(); ZJ.toast(e.message || "Нужно войти", "bad"); ZJ.go("/login"); }
        throw e;
      }
      throw e;
    });
  };

  ZJ.showDisabled = function () {
    ZJ.clearAuth();
    ZJ.mount(ZJ.h("main", { class: "page narrow" }, ZJ.h("div", { class: "card" },
      ZJ.h("h1", { text: "Аккаунт отключён" }),
      ZJ.h("p", { class: "muted", text: "Вход закрыт. Если это ошибка, напишите тому, кто выдавал доступ." }))));
  };

  ZJ.webLogout = function () {
    return apiAuth("/api/auth/logout", {}).catch(function () {}).then(function () { ZJ.clearAuth(); ZJ.go("/"); });
  };

  ZJ.openExternal = function (url) {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (ZJ.tg && tg && /^https:\/\/t\.me\//.test(url) && tg.openTelegramLink) { tg.openTelegramLink(url); return; }
    if (ZJ.tg && tg && tg.openLink) { tg.openLink(url); return; }
    window.open(url, "_blank", "noopener");
  };

  ZJ.boot = function () {
    if (ZJ.tg) return;
    migrate().then(function () {
      if (access) return null;
      return refresh().catch(function () { return null; });
    }).then(function () { ZJ.release(); });
  };
})();
