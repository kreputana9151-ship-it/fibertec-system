/* FiberTec - single dummy data set (front-end only, no database).
   Everything (tables, cards, charts, staff queues, client portal) is derived from this file.
   Changes made in the demo (cancellations, verifications...) are kept in localStorage under STATE_KEY. */

var APP_TODAY = "2026-10-24";               // demo "today" (Juan's statement is due today)
var STATE_KEY = "fibertec.demo.v3";
var MONTHS = [{ k: "2026-10", l: "October 2026" }, { k: "2026-09", l: "September 2026" }, { k: "2026-08", l: "August 2026" }, { k: "2026-07", l: "July 2026" }];
var BRANCHES = [   // counts = [Active, Grace Period, Under Review, Terminated]  (uneven on purpose, 100 clients in total)
  { name: "Bagong Ilog", code: "01", short: "BI", brgy: "Bagong Ilog", counts: [14, 3, 2, 3] },
  { name: "Caniogan", code: "02", short: "CN", brgy: "Caniogan", counts: [5, 1, 1, 1] },
  { name: "Palatiw", code: "03", short: "PT", brgy: "Palatiw", counts: [9, 3, 3, 2] },
  { name: "Maybunga", code: "04", short: "MB", brgy: "Maybunga", counts: [4, 1, 0, 0] },
  { name: "Bliss 1", code: "05", short: "B1", brgy: "San Nicolas", counts: [12, 3, 2, 2] },
  { name: "Nagpayong", code: "06", short: "NP", brgy: "Nagpayong", counts: [7, 1, 1, 2] },
  { name: "Bliss 3", code: "07", short: "B3", brgy: "Maybunga", counts: [11, 3, 2, 2] }
];
var STATUSES = ["Active", "Grace Period", "Under Review", "Terminated"];
var PLANS = [{ n: "LiteSpeed 50Mbps", r: 799, w: .26 }, { n: "Turbo 110 Mbps", r: 999, w: .42 }, { n: "Elite 150 Mbps", r: 1299, w: .20 }, { n: "Premium 220 Mbps", r: 1450, w: .12 }];

/* ---------- tiny helpers ---------- */
var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function iso(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
function parseISO(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function addDays(s, n) { var d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); }
function dayDiff(a, b) { return Math.round((parseISO(a) - parseISO(b)) / 86400000); }
function fmtD(s, short) { var d = parseISO(s); return MON[d.getMonth()] + " " + d.getDate() + (short ? "" : ", " + d.getFullYear()); }
function monthLabel(k) { for (var i = 0; i < MONTHS.length; i++) if (MONTHS[i].k == k) return MONTHS[i].l; return k; }
function monShort(k) { return MON[+k.slice(5, 7) - 1] + " " + k.slice(0, 4); }
function monthDay(k, day) { return k + "-" + ("0" + day).slice(-2); }

var _seed = 20261024;
function rnd() { _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0; var t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function digits(n) { var s = ""; for (var i = 0; i < n; i++) s += ri(0, 9); return s; }

var FIRST = ["Maria", "Jose", "Angelica", "Mark", "Jasmine", "John Paul", "Kristine", "Rafael", "Bea", "Carlo", "Denise", "Miguel", "Patricia", "Joshua", "Camille", "Gabriel", "Rochelle", "Nathan", "Jhoanna", "Arvin", "Liza", "Ramon", "Trisha", "Edgar", "Shiela", "Paolo", "Margie", "Dennis", "Aileen", "Jericho", "Nicole", "Francis", "Hazel", "Renato", "Lyka", "Vincent", "Marites", "Oliver", "Joanna", "Benedict", "Cherry", "Allan", "Clarisse", "Ronnie", "Sheena", "Harold", "Erika", "Lorenzo", "Janelle", "Emmanuel", "Divine", "Kenneth", "Alyssa", "Rey", "Princess", "Jomar", "Mylene", "Dante", "Katrina", "Sherwin"];
var MID = ["Anne", "Grace", "Marie", "Mae", "Louise", "Joy", "Rose", "Lee", "Faith", "Jane", "Dela", "Isabel", "Kate", "Ann"];
var LAST = ["Santos", "Reyes", "Cruz", "Bautista", "Ocampo", "Garcia", "Mendoza", "Torres", "Tomas", "Andrada", "Castillo", "Flores", "Villanueva", "Ramos", "Aquino", "Dizon", "Navarro", "Salazar", "Pascual", "Domingo", "Soriano", "Fernandez", "Lim", "Tan", "Manalo", "Esguerra", "Cabrera", "Valdez", "Rivera", "Gonzales", "Alvarez", "Marquez", "Panganiban", "De Leon", "Magno", "Dimaculangan", "Sarmiento", "Lacson", "Enriquez", "Corpuz", "Agustin", "Macaraeg", "Estrada", "Zamora", "Bernardo", "Pineda", "Lopez", "Padilla", "Hernandez", "Evangelista"];
var STREETS = ["Sampaguita St.", "Mabini St.", "Rizal Ave.", "Caruncho Ave.", "Dr. Sixto Antonio Ave.", "C. Raymundo Ave.", "Pioneer St.", "Evangelista St.", "Shaw Blvd.", "Jasmin St.", "Santan St.", "Kalayaan St."];
var DEVICES = ["Router on the shelf next to the front door", "Router in the living room, beside the TV", "Router on top of the cabinet, 2nd floor hallway", "Router in the bedroom near the window", "Router mounted above the main door", "Router in the small office room"];
var EMAILS = ["gmail.com", "gmail.com", "gmail.com", "yahoo.com", "outlook.com"];

/* ---------- generate the base data set ---------- */
var BASE_CLIENTS = [], BASE_RECORDS = [], BASE_REQUESTS = [];
(function generate() {
  var used = {}, seq = 0;
  /* a few fixed, recognisable demo accounts (kept from the original prototype) */
  var fixed = [
    { name: "Juan Dela Cruz", b: "Bliss 1", s: "Active", plan: 2, due: 24, pay: "Unpaid", installed: "2026-06-24", email: "useraccount@gmail.com", contact: "09171234567", bill: "Delivered", idn: 1001, addr: "Unit 4B, Building 7, Bliss 1, Caruncho Avenue, Barangay San Nicolas, Pasig City" },
    { name: "Cholo Trinidad", b: "Nagpayong", s: "Active", plan: 1, due: 3, pay: "Paid", bill: "Delivered", email: "cholo@gmail.com", contact: "09175550333" },
    { name: "Keziah Harriette Reputana", b: "Bagong Ilog", s: "Grace Period", plan: 3, due: 21, pay: "Unpaid", bill: "Failed", email: "reputana@gmail.com", contact: "09937162786" },
    { name: "Danee Anne Arquero", b: "Bagong Ilog", s: "Active", plan: 0, due: 30, pay: "Paid", email: "arquero@gmail.com", contact: "09937267892" },
    { name: "Iris Mie Yadao", b: "Maybunga", s: "Active", plan: 1, due: 25, pay: "Partially paid", email: "yadao@gmail.com", contact: "09422298771" },
    { name: "Elaisa Nicole Bartolome", b: "Palatiw", s: "Terminated", plan: 2, due: 20, pay: "Unpaid", email: "Barts@gmail.com", contact: "09454478949" },
    { name: "Iris Anne Reputana", b: "Palatiw", s: "Under Review", plan: 1, due: 23, pay: "Unpaid", reason: "Non-payment", email: "anne@gmail.com", contact: "09488763422" },
    { name: "Maria Santos", b: "Bliss 1", s: "Active", plan: 0, due: 12, pay: "Paid", email: "maria@gmail.com", contact: "09175550102" },
    { name: "Pedro Reyes", b: "Bliss 1", s: "Grace Period", plan: 1, due: 20, pay: "Unpaid", email: "pedro@gmail.com", contact: "09175550211" },
    { name: "Lara Mendoza", b: "Bliss 1", s: "Under Review", plan: 2, due: 15, pay: "Unpaid", reason: "Client Cancellation Request", email: "lara@gmail.com", contact: "09175550390" },
    { name: "Rico Aquino", b: "Bliss 1", s: "Terminated", plan: 3, due: 10, pay: "Pending", email: "rico@gmail.com", contact: "09175550155" }
  ];
  function randName() { var n; do { n = pick(FIRST) + (rnd() < .45 ? " " + pick(MID) : "") + " " + pick(LAST); } while (used[n]); used[n] = 1; return n; }
  function weightedPlan() { var r = rnd(), a = 0; for (var i = 0; i < PLANS.length; i++) { a += PLANS[i].w; if (r < a) return i; } return 1; }
  for (var f = 0; f < fixed.length; f++) used[fixed[f].name] = 1;

  BRANCHES.forEach(function (br) {
    var sts = [];
    STATUSES.forEach(function (s, si) { for (var k = 0; k < br.counts[si]; k++) sts.push(s); });
    shuffle(sts);
    var slotFixed = {};
    fixed.filter(function (f) { return f.b == br.name; }).forEach(function (f) { for (var i = 0; i < sts.length; i++) if (sts[i] == f.s && !slotFixed[i]) { slotFixed[i] = f; break; } });
    sts.forEach(function (s, i) {
      var f = slotFixed[i] || {}, pi = f.plan != null ? f.plan : weightedPlan(), plan = PLANS[pi];
      var inst = f.installed || iso(new Date(2024, 0, 5 + Math.floor(rnd() * 960)));
      if (inst > "2026-08-30") inst = "2026-08-30";
      var name = f.name || randName(), parts = name.toLowerCase().split(" ");
      var due, pay = f.pay, reason = null;
      if (s == "Active") { if (!pay) { var r = rnd(); pay = r < .62 ? "Paid" : r < .74 ? "Partially paid" : "Unpaid"; } due = f.due || (pay == "Paid" ? pick([3, 5, 8, 10, 12, 15, 17, 20, 22, 24, 25, 26, 28, 30]) : pick([24, 25, 26, 27, 28, 30])); }
      else if (s == "Grace Period") { if (!pay) pay = rnd() < .75 ? "Unpaid" : "Partially paid"; due = f.due || ri(17, 23); }
      else if (s == "Under Review") { reason = f.reason || (rnd() < .4 ? "Client Cancellation Request" : "Non-payment"); if (!pay) pay = reason == "Non-payment" ? "Unpaid" : (rnd() < .5 ? "Paid" : "Unpaid"); due = f.due || ri(10, 20); }
      else { if (!pay) { var q = rnd(); pay = q < .45 ? "Unpaid" : q < .7 ? "Pending" : "Paid"; } due = f.due || ri(5, 20); }
      var br2 = rnd(), idn = f.idn || (1002 + i);
      var c = {
        no: br.code + inst.slice(2, 4) + idn, name: name, branch: br.name, short: br.short, status: s, plan: plan.n, rate: plan.r,
        contact: f.contact || "09" + digits(9), email: f.email || (parts[0] + parts[parts.length - 1].replace(/[^a-z]/g, "") + ri(1, 99) + "@" + pick(EMAILS)),
        installed: inst, due: due, dueISO: monthDay("2026-10", due),
        address: f.addr || ("Unit " + ri(1, 40) + pick(["A", "B", "C", ""]) + ", " + pick(STREETS) + ", Brgy. " + br.brgy + ", Pasig City"),
        device: pick(DEVICES), fb: "fb.com/" + parts[0] + "." + ri(100, 999),
        bill: f.bill || (br2 < .62 ? "Delivered" : br2 < .93 ? "Not Yet Sent" : "Failed"),
        reason: reason, flagged: null, graceEnd: null, termDate: null, termReason: null, _pay: pay
      };
      if (s == "Under Review") c.flagged = monthDay("2026-10", ri(15, 23));
      if (s == "Grace Period") c.graceEnd = addDays(c.dueISO, 7);
      if (s == "Terminated") { c.termDate = monthDay("2026-10", ri(1, 23)); c.termReason = rnd() < .3 ? "Client Cancellation Request" : "Non-Payment"; }
      BASE_CLIENTS.push(c);
    });
  });

  /* payment records: Oct (current cycle) from each client's target payment status, plus Jul-Sep history */
  var rid = 0;
  function rec(c, m, day, amount, method, status, type) {
    var code = method == "Cash" ? digits(5) : digits(13);
    BASE_RECORDS.push({ id: "P" + (++rid), date: monthDay(m, Math.max(1, Math.min(day, m == "2026-10" ? 24 : 28))), month: m, ref: method == "Cash" ? "" : code, or: method == "Cash" ? "OR-" + code : "", acc: c.no, name: c.name, branch: c.branch, amount: amount, method: method, status: status, type: type || "Full payment" });
  }
  BASE_CLIENTS.forEach(function (c) {
    var p = c._pay, d = c.due, m = rnd() < .65 ? "GCash" : "Cash";
    if (p == "Paid") rec(c, "2026-10", Math.min(d, 24) - ri(0, 4), c.rate, m, "Verified");
    else if (p == "Partially paid") rec(c, "2026-10", 24, c.rate / 2, m, "Verified", "Partial payment");
    else if (p == "Pending" || ((c.status == "Active" || c.status == "Grace Period") && p == "Unpaid" && c.name != "Juan Dela Cruz" && rnd() < .38)) rec(c, "2026-10", ri(20, 24), c.rate, "GCash", "Pending");
    ["2026-09", "2026-08", "2026-07"].forEach(function (mm) {
      if (c.installed >= mm + "-01") return;
      if (c.name == "Juan Dela Cruz" || rnd() < .93) rec(c, mm, d - ri(0, 4), c.rate, rnd() < .65 ? "GCash" : "Cash", "Verified");
    });
  });
  if (!BASE_CLIENTS.some(function (c) { return c.name == "Juan Dela Cruz"; })) throw new Error("demo client missing");

  /* a few cancellation requests already waiting in each staff portal */
  BRANCHES.forEach(function (br) {
    var pool = BASE_CLIENTS.filter(function (c) { return c.branch == br.name && c.status == "Active" && c.name != "Juan Dela Cruz"; });
    var n = br.code == "01" ? 2 : 1;
    for (var i = 0; i < n && pool.length; i++) { var c = pool.splice(ri(0, pool.length - 1), 1)[0]; BASE_REQUESTS.push({ id: "C" + br.code + (i + 1), acc: c.no, name: c.name, branch: c.branch, date: monthDay("2026-10", ri(19, 23)), status: "Pending", reason: pick(["Moving to a new address", "Switching provider", "Financial reasons", "No longer needs internet"]) }); }
  });
})();

/* ---------- persisted demo state ---------- */
var S = (function () { try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch (e) { return {}; } })();
S.ov = S.ov || {};       // client overrides by account no: {status, reason, flagged, termDate, termReason, bill}
S.rec = S.rec || {};     // record status overrides by id
S.extra = S.extra || []; // new payment records
S.req = S.req || {};     // cancellation request status overrides by id
S.newReq = S.newReq || [];
S.act = S.act || [];     // staff activity {b, t, when}
S.nres = S.nres || {};   // notices re-sent
S.add = S.add || [];     // newly registered clients
function saveState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch (e) { } }
function resetDemo() { try { localStorage.removeItem(STATE_KEY); sessionStorage.clear(); } catch (e) { } }

var clients = [], records = [], requests = [], CBYNO = {};
function copy(o) { var x = {}, k; for (k in o) x[k] = o[k]; return x; }
function rebuild() {
  clients = BASE_CLIENTS.map(function (b) { var c = copy(b), o = S.ov[c.no], k; if (o) for (k in o) c[k] = o[k]; return c; }).concat(S.add.map(function (a) { var c = copy(a), o = S.ov[c.no], k; if (o) for (k in o) c[k] = o[k]; return c; }));
  CBYNO = {}; clients.forEach(function (c) { CBYNO[c.no] = c; });
  records = BASE_RECORDS.map(function (r) { var x = copy(r); if (S.rec[x.id]) x.status = S.rec[x.id]; return x; }).concat(S.extra);
  records.forEach(function (r, i) {
    r._o = i;
    if (r.method == "Cash" && /^OR-/.test(r.ref)) { r.or = r.ref; r.ref = ""; }          // old saved cash entries
    if (r.status == "Verified" && !r.or) r.or = "OR-" + (30000 + i);                      // O.R. is issued once a payment is verified (GCash too)
    if (r.status != "Verified") r.or = r.method == "Cash" ? r.or : "";                     // pending / rejected GCash payments have no O.R. yet
  });
  requests = BASE_REQUESTS.concat(S.newReq).map(function (r) { var x = copy(r); if (S.req[x.id]) x.status = S.req[x.id]; return x; });
  clients.forEach(derivePay);
}
/* payment status for the current cycle, derived from the payment records */
function derivePay(c) {
  var v = 0, pend = false;
  for (var i = 0; i < records.length; i++) { var r = records[i]; if (r.acc != c.no || r.month != "2026-10") continue; if (r.status == "Verified") v += r.amount; else if (r.status == "Pending") pend = true; }
  c.paid = v; c.hasPending = pend;
  c.pay = v >= c.rate ? "Paid" : v > 0 ? "Partially paid" : (c.status == "Terminated" && pend ? "Pending" : "Unpaid");
  c.balance = Math.max(0, c.rate - v);
  c.graceLeft = c.graceEnd ? dayDiff(c.graceEnd, APP_TODAY) : null;
}
rebuild();
function setClient(no, patch) { S.ov[no] = S.ov[no] || {}; for (var k in patch) S.ov[no][k] = patch[k]; saveState(); rebuild(); }
function clientByNo(no) { return CBYNO[no]; }
function inBilling(c) { return c.status == "Active" || c.status == "Grace Period"; }
function branchOf(name) { for (var i = 0; i < BRANCHES.length; i++) if (BRANCHES[i].name == name) return BRANCHES[i]; return null; }

/* ---------- invoice + statement helpers ---------- */
function invoiceNo(c, m) { return c.short + " - " + m.slice(2, 4) + m.slice(5, 7) + " - " + c.no.slice(4); }
function acctLabel(c) { return c.short + " - " + c.no.slice(4); }
function dueISO(c, m) { return monthDay(m, c.due); }
function billISO(c, m) { return addDays(dueISO(c, m), -7); }
function hasStatement(c, m) { return c.installed < m + "-01" && (m != "2026-10" || inBilling(c)); }
function statement(c, m) {
  var recs = records.filter(function (r) { return r.acc == c.no && r.month == m; }), paid = 0;
  recs.forEach(function (r) { if (r.status == "Verified") paid += r.amount; });
  return { m: m, inv: invoiceNo(c, m), bill: billISO(c, m), due: dueISO(c, m), amount: c.rate, paid: paid, balance: Math.max(0, c.rate - paid),
    pay: paid >= c.rate ? "Paid" : paid > 0 ? "Partially paid" : "Unpaid", send: m == "2026-10" ? c.bill : "Delivered", recs: recs };
}
function statementsFor(m, branch) { return clients.filter(function (c) { return (!branch || c.branch == branch) && hasStatement(c, m); }).map(function (c) { var s = statement(c, m); s.c = c; return s; }); }
function paymentsFor(m, branch) { return records.filter(function (r) { return (!m || r.month == m) && (!branch || r.branch == branch); }); }
function sumVerified(list) { var t = 0; list.forEach(function (r) { if (r.status == "Verified") t += r.amount; }); return t; }
function statusCounts(list) { var o = { "Active": 0, "Grace Period": 0, "Under Review": 0, "Terminated": 0 }; list.forEach(function (c) { o[c.status]++; }); return o; }

/* notices (email + portal) derived from statements and payments */
function buildNotices() {
  var out = [], n = 0;
  function add(c, date, channel, type, status) { var id = "N" + (++n); out.push({ id: id, date: date, acc: c.no, name: c.name, branch: c.branch, channel: channel, recipient: channel == "Email" ? c.email : "Client App Bell Dropdown", type: type, status: S.nres[id] || status }); }
  clients.forEach(function (c) {
    if (inBilling(c)) {
      add(c, billISO(c, "2026-10"), "Email", "7-Day Billing Notice", c.bill == "Delivered" ? "Sent" : c.bill);
      if (c.bill == "Delivered") add(c, billISO(c, "2026-10"), "Portal Notification", "7-Day Billing Notice", "Sent");
    }
    if (c.status == "Grace Period") add(c, addDays(c.dueISO, 1), c.bill == "Failed" ? "Email" : "Portal Notification", "Disconnection Warning", c.bill == "Failed" ? "Failed" : "Sent");
    else if (c.status == "Under Review") add(c, c.flagged || APP_TODAY, "Portal Notification", "System Notice", "Sent");
  });
  records.forEach(function (r) { if (r.month == "2026-10" && r.status == "Verified") { var c = CBYNO[r.acc]; if (c) add(c, r.date, r.method == "GCash" ? "Email" : "Portal Notification", "Payment Receipt", "Sent"); } });
  out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  var failed = out.filter(function (n) { return n.status == "Failed"; }).slice(0, 4), rest = out.filter(function (n) { return n.status != "Failed"; }).slice(0, 26);
  return failed.concat(rest).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });   // small list, failed ones always included
}

/* ---------- workflow actions (shared) ---------- */
function nowStamp() { var d = new Date(), h = d.getHours(), m = ("0" + d.getMinutes()).slice(-2); return fmtD(APP_TODAY) + " · " + ((h + 11) % 12 + 1) + ":" + m + (h < 12 ? " AM" : " PM"); }
function logActivity(branch, text) { S.act.push({ b: branch, t: text, when: nowStamp() }); saveState(); }
function addRecord(r) { r.id = "X" + Date.now() + Math.floor(Math.random() * 1000); r.month = "2026-10"; r.date = APP_TODAY; S.extra.push(r); saveState(); rebuild(); }
function setRecordStatus(id, status) {
  for (var i = 0; i < S.extra.length; i++) if (S.extra[i].id == id) { S.extra[i].status = status; saveState(); rebuild(); return; }
  S.rec[id] = status; saveState(); rebuild();
}
function myCancelRequest(acc) { var l = requests.filter(function (r) { return r.acc == acc; }); return l.length ? l[l.length - 1] : null; }
function submitCancelRequest(c, reason) {
  S.newReq.push({ id: "CN" + Date.now(), acc: c.no, name: c.name, branch: c.branch, date: APP_TODAY, status: "Pending", reason: reason || "Client request" });
  saveState(); rebuild();
}
function resolveCancelRequest(id, approve) {
  var r = requests.filter(function (x) { return x.id == id; })[0]; if (!r) return;
  S.req[id] = approve ? "Approved" : "Rejected";
  if (approve) { S.ov[r.acc] = S.ov[r.acc] || {}; S.ov[r.acc].status = "Under Review"; S.ov[r.acc].reason = "Client Cancellation Request"; S.ov[r.acc].flagged = APP_TODAY; S.ov[r.acc].graceEnd = null; }
  saveState(); rebuild();
  logActivity(r.branch, (approve ? "Approved" : "Rejected") + " cancellation request of " + r.name + " (" + r.acc + ")." + (approve ? " Account sent to Admin for review." : ""));
}
