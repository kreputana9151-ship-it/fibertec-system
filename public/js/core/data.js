/* FiberTec - shared branch, plan, and date helpers for the database-backed portals. */
var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function iso(d) {
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}
function parseISO(value) {
  if (value == null || value === "") return new Date(NaN);
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === "string") {
    value = value.trim();
    if (!value || value === "null" || value === "undefined") return new Date(NaN);
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      var d = new Date(+match[1], +match[2] - 1, +match[3]);
      return d.getFullYear() === +match[1] && d.getMonth() === +match[2] - 1 && d.getDate() === +match[3] ? d : new Date(NaN);
    }
  }
  return new Date(value);
}
function addDays(value, days) {
  var d = parseISO(value);
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + days);
  return iso(d);
}
function dayDiff(a, b) { return Math.round((parseISO(a) - parseISO(b)) / 86400000); }
function fmtD(value, short) {
  var d = parseISO(value);
  if (isNaN(d.getTime())) return "—";
  return MON[d.getMonth()] + " " + d.getDate() + (short ? "" : ", " + d.getFullYear());
}
function validMonthKey(key) { return typeof key === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(key); }
function monthLabel(key) {
  if (!key) return "All Months";
  if (!validMonthKey(key)) return "—";
  for (var i = 0; i < MONTHS.length; i++) if (MONTHS[i].k == key) return MONTHS[i].l;
  return new Date(key + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
function monShort(key) { return validMonthKey(key) ? MON[+key.slice(5, 7) - 1] + " " + key.slice(0, 4) : "—"; }
function monthDay(key, day) { return key + "-" + ("0" + day).slice(-2); }

var APP_TODAY = iso(new Date());
var MONTHS = (function () {
  var rows = [], date = new Date();
  date.setDate(1);
  for (var i = 0; i < 4; i++) {
    var key = iso(date).slice(0, 7);
    rows.push({ k: key, l: new Date(key + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) });
    date.setMonth(date.getMonth() - 1);
  }
  return rows;
})();
var BRANCHES = [
  { name: "Bagong Ilog", code: "01", short: "BI", brgy: "Bagong Ilog" },
  { name: "Caniogan", code: "02", short: "CN", brgy: "Caniogan" },
  { name: "Palatiw", code: "03", short: "PT", brgy: "Palatiw" },
  { name: "Maybunga Bliss 3", code: "04", short: "B3", brgy: "Maybunga" },
  { name: "Maybunga Bliss 1", code: "05", short: "B1", brgy: "Maybunga" },
  { name: "Nagpayong", code: "06", short: "NP", brgy: "Nagpayong" }
];
var STATUSES = ["Active", "Grace Period", "Under Review", "Terminated"];
var PLANS = [
  { n: "LiteSpeed 50Mbps", r: 799 },
  { n: "Turbo 110 Mbps", r: 999 },
  { n: "Elite 150 Mbps", r: 1299 },
  { n: "Premium 220 Mbps", r: 1450 }
];

var clients = [], records = [], requests = [];
function branchOf(name) {
  for (var i = 0; i < BRANCHES.length; i++) if (BRANCHES[i].name == name) return BRANCHES[i];
  return null;
}
function clientByNo() { return null; }
function inBilling(client) { return client.status == "Active" || client.status == "Grace Period"; }
function statusCounts(list) {
  var counts = { "Active": 0, "Grace Period": 0, "Under Review": 0, "Terminated": 0 };
  list.forEach(function (client) { if (counts[client.status] != null) counts[client.status]++; });
  return counts;
}
