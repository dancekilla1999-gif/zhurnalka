/* Чистые функции кабинета: их можно проверить без браузера. */
(function (g) {
  function day(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var dd = String(d.getDate());
    var mm = String(d.getMonth() + 1);
    if (dd.length < 2) dd = "0" + dd;
    if (mm.length < 2) mm = "0" + mm;
    return dd + "." + mm;
  }
  function tariffText(plan) {
    if (!plan || plan.active === false || plan.status === "expired" || plan.status === "inactive") {
      return "Подписка неактивна";
    }
    var name = plan.name || "Журналка";
    var until = plan.untilLabel || day(plan.until);
    if (until) return "Тариф: " + name + ", активен до " + until;
    return "Тариф: " + name;
  }
  var api = { tariffText: tariffText, consentVersion: "2026-11-26-1" };
  g.ZJLogic = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
