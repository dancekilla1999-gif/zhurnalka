/* «Журналка» — справочник журналов, даты по Москве, форматирование температуры. */
(function () {
  "use strict";
  var ZJ = window.ZJ;

  ZJ.J = {
    health: { key: "health", short: "Здоровье персонала", title: "Гигиенический журнал (сотрудники)", who: "Каждый сотрудник перед сменой", mandatory: true },
    fridge: { key: "fridge", short: "Холодильники", title: "Журнал учёта температурного режима холодильного оборудования", who: "Ежедневно по каждому холодильнику", mandatory: true, unit: "fridge" },
    store: { key: "store", short: "Склады", title: "Журнал учёта температуры и влажности в складских помещениях", who: "Ежедневно по каждому складу", mandatory: true, unit: "store" },
    fryer: { key: "fryer", short: "Фритюрные жиры", title: "Журнал учёта использования фритюрных жиров", who: "Если в меню есть жареное во фритюре", mandatory: true, unit: "fryer" },
    brak: { key: "brak", short: "Бракераж", title: "Журнал бракеража готовой пищевой продукции", who: "Перед выдачей блюд", mandatory: false },
    clean: { key: "clean", short: "Генеральные уборки", title: "Журнал проведения генеральных уборок", who: "По графику уборок", mandatory: false }
  };
  ZJ.J_ORDER = ["health", "fridge", "store", "fryer", "brak", "clean"];
  ZJ.UNIT_KIND = {
    fridge: { one: "холодильник", title: "Холодильное оборудование", add: "Добавить холодильник" },
    store: { one: "склад", title: "Складские помещения", add: "Добавить склад" },
    fryer: { one: "фритюрница", title: "Фритюрницы", add: "Добавить фритюрницу" }
  };
  ZJ.PRESETS = [
    { kind: "fridge", name: "Холодильник среднетемпературный", t_min: 2, t_max: 6 },
    { kind: "fridge", name: "Морозильный ларь", t_min: -25, t_max: -18 },
    { kind: "fridge", name: "Холодильный стол", t_min: 2, t_max: 6 },
    { kind: "fridge", name: "Витрина холодильная", t_min: 2, t_max: 6 },
    { kind: "store", name: "Склад сухих продуктов", t_min: 10, t_max: 25, h_max: 75 },
    { kind: "store", name: "Овощной склад", t_min: 2, t_max: 10, h_max: 90 },
    { kind: "fryer", name: "Фритюрница" }
  ];
  ZJ.GRADES = ["отлично", "хорошо", "удовлетворительно", "неудовлетворительно"];
  ZJ.ROLES = ["повар", "су-шеф", "шеф-повар", "кондитер", "заготовщик", "мойщица", "официант", "бармен", "администратор", "управляющий"];

  var TZ = "Europe/Moscow";
  ZJ.todayISO = function () {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return p; // YYYY-MM-DD
  };
  ZJ.monthISO = function () { return ZJ.todayISO().slice(0, 7); };
  ZJ.monthRange = function (ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: ym + "-01", to: ym + "-" + String(last).padStart(2, "0"), days: last };
  };
  ZJ.monthName = function (ym) {
    var d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 15));
    var s = d.toLocaleString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
    return s.charAt(0).toUpperCase() + s.slice(1).replace(" г.", "");
  };
  ZJ.monthShift = function (ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + "-" + String(m + 1).padStart(2, "0");
  };
  ZJ.dayFmt = function (iso) {
    if (!iso) return "—";
    var p = iso.slice(0, 10).split("-");
    return p[2] + "." + p[1] + "." + p[0];
  };
  ZJ.timeFmt = function (iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  };
  ZJ.dayLeft = function (iso) {
    if (!iso) return null;
    var a = Date.parse(iso.slice(0, 10) + "T00:00:00Z"), b = Date.parse(ZJ.todayISO() + "T00:00:00Z");
    return Math.round((a - b) / 86400000);
  };
  ZJ.t = function (v) {
    if (v == null || v === "") return "—";
    var n = Number(v);
    return (n > 0 ? "+" : n < 0 ? "−" : "") + String(Math.abs(n)).replace(".", ",") + " °C";
  };
  ZJ.range = function (u) {
    if (u.t_min == null && u.t_max == null) return "";
    if (u.t_min != null && u.t_max != null) return "норма " + ZJ.t(u.t_min).replace(" °C", "") + "…" + ZJ.t(u.t_max);
    return u.t_min != null ? "не ниже " + ZJ.t(u.t_min) : "не выше " + ZJ.t(u.t_max);
  };
  ZJ.outOfRange = function (u, t, h) {
    if (t === "" || t == null || isNaN(Number(t))) return false;
    t = Number(t);
    if (u.t_min != null && t < Number(u.t_min)) return true;
    if (u.t_max != null && t > Number(u.t_max)) return true;
    if (h != null && h !== "" && u.h_max != null && Number(h) > Number(u.h_max)) return true;
    return false;
  };
  ZJ.parseNum = function (s) {
    s = String(s == null ? "" : s).trim().replace(",", ".").replace("−", "-").replace(/^\+/, "");
    if (!/^-?\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
    return Number(s);
  };
  ZJ.appUrl = function (path) {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "#" + path;
  };
})();
