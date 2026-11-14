/* FiberTec - Admin portal pages (Live Neon API integration) */
var ADMIN_PAGES = ["dash", "clients", "billing", "pay", "analytics", "email"];
var STATUS_COLORS = ["#4cb153", "#fde400", "#fdad00", "#ff5454"], C_BILLED = "#3167bd", C_COLL = "#2daea6";
var BILL = { sel: null }, NT = { tab: "All" };

var LIVE = {
  clients: [],
  statements: [],
  payments: [],
  notices: [],
  loaded: false
};

var BRANCH_MAP = {
  "01": "Makati",
  "02": "Taguig",
  "03": "Pasig",
  "04": "Quezon City",
  "05": "Manila",
  "06": "Parañaque"
};

function branchCodeForName(name) {
  if (!name) return "";
  for (var k in BRANCH_MAP) {
    if (BRANCH_MAP[k] === name) return k;
  }
  return name;
}

function branchNameForCode(code) {
  return BRANCH_MAP[code] || code || "";
}

async function adminApi(path, opts) {
  var res = await fetch("/api/admin" + path, Object.assign({
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin"
  }, opts || {}));
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
  return data;
}

async function syncAdminData() {
  var results = await Promise.all([
    adminApi("/clients"),
    adminApi("/statements"),
    adminApi("/payments"),
    adminApi("/notices")
  ]);

  LIVE.clients = results[0].map(function (c) {
    return {
      no: c.account_no,
      name: c.name,
      branch: c.branch,
      branch_code: branchCodeForName(c.branch),
      plan: c.plan_name,
      status: c.status,
      due_day: c.due_day,
      email: c.email || "",
      address: c.address || c.branch + " Service Area",
      short: c.plan_name,
      rate: Number(c.monthly_rate || 0)
    };
  });

  var clientByAcc = {};
  LIVE.clients.forEach(function (c) { clientByAcc[c.no] = c; });

  LIVE.statements = results[1].map(function (s) {
    var c = clientByAcc[s.account_no] || {
      no: s.account_no,
      name: s.name || s.account_no,
      branch: branchNameForCode(s.branch_code),
      branch_code: s.branch_code,
      plan: "Fiber Plan",
      status: "Active",
      email: "",
      address: ""
    };
    var bm = String(s.billing_month || "").slice(0, 7);
    return {
      id: s.statement_id,
      inv: s.invoice_no,
      acc: s.account_no,
      c: c,
      month: bm,
      bill: String(s.bill_date || "").slice(0, 10),
      due: String(s.due_date || "").slice(0, 10),
      amount: Number(s.amount || 0),
      paid: Number(s.amount_paid || 0),
      balance: Number(s.balance || 0),
      pay: s.payment_status || "Unpaid",
      send: s.send_status || "Not Yet Sent"
    };
  });

  LIVE.payments = results[2].map(function (p, idx) {
    var dt = String(p.payment_date || p.created_at || "").slice(0, 10);
    return {
      _i: idx,
      _o: p.payment_id || idx,
      id: p.payment_id,
      statement_id: p.statement_id,
      acc: p.account_no,
      name: p.name || p.account_no,
      branch: p.branch || branchNameForCode(p.branch_code),
      date: dt,
      month: dt.slice(0, 7),
      amount: Number(p.amount || p.amount_paid || 0),
      method: p.payment_method || p.method || "GCash",
      ref: p.reference_no || p.ref_no || "",
      or: p.or_no || p.official_receipt || "",
      status: p.status || "Pending"
    };
  });

  LIVE.notices = results[3].map(function (n) {
    var c = clientByAcc[n.account_no] || {};
    return {
      id: n.notice_id,
      date: String(n.notice_date || n.created_at || "").slice(0, 10),
      acc: n.account_no,
      name: n.name || c.name || n.account_no,
      branch: c.branch || "",
      channel: n.channel || "Email",
      recipient: n.recipient || c.email || "Client Portal",
      type: n.notice_type || "System Notice",
      status: n.delivery_status || "Sent"
    };
  });

  LIVE.loaded = true;
}

function liveClients(branchName) {
  return LIVE.clients.filter(function (c) { return !branchName || c.branch === branchName; });
}

function liveStatements(monthYm, branchName) {
  return LIVE.statements.filter(function (s) {
    return (!monthYm || s.month === monthYm) && (!branchName || s.c.branch === branchName);
  });
}

function livePayments(monthYm, branchName) {
  return LIVE.payments.filter(function (p) {
    return (!monthYm || p.month === monthYm) && (!branchName || p.branch === branchName);
  });
}

function liveSumVerified(list) {
  var sum = 0;
  list.forEach(function (p) { if (p.status === "Verified") sum += p.amount; });
  return sum;
}

function liveStatusCounts(list) {
  var out = { Active: 0, "Grace Period": 0, "Under Review": 0, Terminated: 0 };
  list.forEach(function (c) {
    if (out[c.status] !== undefined) out[c.status]++;
  });
  return out;
}

async function showAdmin(id) {
  showSection(ADMIN_PAGES, id, "a-");
  hideTip();
  try {
    await syncAdminData();
  } catch (e) {
    toast("Database sync warning: " + e.message);
  }
  ({ dash: renderDash, clients: renderClients, billing: renderBilling, pay: renderPayments, analytics: renderAnalytics, email: renderNotices })[id]();
}
function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
function branchScope(id) {
  var b = val(id);
  if (b) return [b];
  var names = [];
  LIVE.clients.forEach(function (c) { if (c.branch && names.indexOf(c.branch) < 0) names.push(c.branch); });
  return names.length ? names : Object.keys(BRANCH_MAP).map(function (k) { return BRANCH_MAP[k]; });
}

/* ---------- Dashboard ---------- */
function renderDash() {
  var b = val("d-branch"), m = val("d-month") || new Date().toISOString().slice(0, 7);
  var cl = liveClients(b), cnt = liveStatusCounts(cl);
  var stm = liveStatements(m, b), billed = 0;
  stm.forEach(function (s) { billed += s.amount; });
  var pays = livePayments(m, b), coll = liveSumVerified(pays), out = Math.max(0, billed - coll);

  $("d-stats").innerHTML =
    '<div class="stat" style="background:#00417c"><b>Total Clients</b><span>' + cl.length + '</span><small>' + cnt.Active + ' active + ' + cnt["Grace Period"] + ' grace + ' + cnt["Under Review"] + ' review + ' + cnt.Terminated + ' terminated</small></div>' +
    '<div class="stat" style="background:#5197d7"><b>Total Billed amount</b><span>' + peso(billed) + '</span><small>' + stm.length + ' statements</small></div>' +
    '<div class="stat" style="background:#3167bd"><b>Total Collections Verified</b><span>' + peso(coll) + '</span><small>' + pct(coll, billed) + '% of billed</small></div>' +
    '<div class="stat" style="background:#2daea6"><b>Total Outstanding Receivables</b><span>' + peso(out) + '</span><small>' + pct(out, billed) + '% of billed</small></div>';

  var rows = "", tc = 0, ta = 0, tb = 0, tcol = 0;
  branchScope("d-branch").forEach(function (bn) {
    var bc = liveClients(bn), bs = liveStatements(m, bn), bb = 0;
    bs.forEach(function (s) { bb += s.amount; });
    var cc = liveSumVerified(livePayments(m, bn)), p = pct(cc, bb), act = liveStatusCounts(bc).Active;
    tc += bc.length; ta += act; tb += bb; tcol += cc;
    rows += "<tr><td>" + esc(bn) + "</td><td><div class='track' title='" + p + "% collected'><i style='width:0' data-w='" + Math.min(100, p) + "%'></i></div></td><td>" + bc.length + "</td><td>" + act + "</td><td>" + p + "%</td></tr>";
  });
  $("branch-bars").innerHTML = "<table class='bp'><thead><tr><th>Branch</th><th>Billing Cycle Progress</th><th>Clients</th><th>Active</th><th>Collected</th></tr></thead><tbody>" + rows + "</tbody><tfoot><tr><td>Total</td><td></td><td>" + tc + "</td><td>" + ta + "</td><td>" + pct(tcol, tb) + "%</td></tr></tfoot></table>";
  growIn($("branch-bars"));

  var vals = STATUSES.map(function (s) { return cnt[s] || 0; }), lg = "";
  STATUSES.forEach(function (s, i) { lg += "<p><i style='background:" + STATUS_COLORS[i] + "'></i>" + s + "<span>" + vals[i] + "</span></p>"; });
  setDonut("status-donut", vals, STATUS_COLORS);
  $("donut-n").innerHTML = cl.length + "<small>clients</small>";
  $("status-legend").innerHTML = lg + "<p class='total'>Total<span>" + cl.length + "</span></p>";

  var names = branchScope("d-branch"), bl = [], co = [];
  names.forEach(function (bn) {
    var t = 0;
    liveStatements(m, bn).forEach(function (s) { t += s.amount; });
    bl.push(t);
    co.push(liveSumVerified(livePayments(m, bn)));
  });
  barChart({
    id: "dash-chart",
    labels: names,
    h: 210,
    fmt: pesoPlainK,
    sub: monthLabel(m),
    series: [
      { name: "Billed", color: C_BILLED, vals: bl, exact: function (v) { return pesoPlain(v); } },
      { name: "Collected", color: C_COLL, vals: co, exact: function (v) { return pesoPlain(v); } }
    ],
    extra: function (i) { return "Collection rate: <b>" + pct(co[i], bl[i]) + "%</b> &middot; Outstanding: " + pesoPlain(Math.max(0, bl[i] - co[i])); }
  });

  var rp = pays.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b._o - a._o; }).slice(0, 12);
  var h = "<thead><tr><th>Date</th><th>Client Name</th><th>Amount</th><th>Status</th></tr></thead><tbody>";
  rp.forEach(function (r) {
    h += "<tr><td>" + fmtD(r.date) + "</td><td>" + esc(r.name) + "</td><td>" + peso(r.amount) + "</td><td>" + badgeFor(r.status) + "</td></tr>";
  });
  $("recent-pay").innerHTML = h + (rp.length ? "" : "<tr><td colspan='4' class='muted'>No payments for this selection.</td></tr>") + "</tbody>";
}
function pesoPlainK(v) { return v >= 1000 ? "\u20B1" + (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "K" : "\u20B1" + v; }

/* ---------- Billing ---------- */
function billRows() {
  var m = val("b-month") || new Date().toISOString().slice(0, 7), b = val("b-branch"), st = val("b-status"), q = val("b-search").trim().toLowerCase();
  var all = liveStatements(m, b);
  return {
    all: all,
    rows: all.filter(function (s) {
      return (!st || s.send === st) && (!q || (s.acc + " " + s.c.name + " " + s.inv).toLowerCase().indexOf(q) >= 0);
    })
  };
}
function onBillFilter() { pgReset("billing"); renderBilling(); }
function renderBilling() {
  var m = val("b-month") || new Date().toISOString().slice(0, 7), r = billRows(), cnt = { Delivered: 0, "Not Yet Sent": 0, Failed: 0 };
  r.all.forEach(function (s) { if (cnt[s.send] !== undefined) cnt[s.send]++; });
  $("b-stats").innerHTML =
    '<div class="stat" style="background:#3167bd"><b>Total Statements</b><span>' + r.all.length + '</span></div>' +
    '<div class="stat" style="background:#81c715"><b>Delivered</b><span>' + cnt.Delivered + '</span></div>' +
    '<div class="stat" style="background:#10c3b8"><b>Not Yet Sent</b><span>' + cnt["Not Yet Sent"] + '</span></div>' +
    '<div class="stat" style="background:#d74548"><b>Failed</b><span>' + cnt.Failed + '</span></div>';
  $("bill-title").innerHTML = "BILLING FOR " + monthLabel(m).toUpperCase() + " <span class='muted'>(live database records)</span>";

  var info = paginate("billing", r.rows);
  var h = "<thead><tr><th>Invoice No.</th><th class='col-x'>Account No.</th><th>Client Name</th><th class='col-x'>Branch</th><th>Billing Date</th><th>Due Date</th><th>Amount Due</th><th>Status</th></tr></thead><tbody>";
  info.rows.forEach(function (s) {
    h += "<tr class='click " + (BILL.sel === s.id ? "sel" : "") + "' onclick='toggleBill(" + s.id + ")'><td>" + esc(s.inv) + "</td><td class='col-x'>" + esc(s.acc) + "</td><td>" + esc(s.c.name) + "</td><td class='col-x'>" + esc(s.c.branch) + "</td><td>" + fmtD(s.bill) + "</td><td>" + fmtD(s.due) + "</td><td>" + peso(s.amount) + "</td><td>" + badgeFor(s.send) + "</td></tr>";
  });
  if (!r.rows.length) h += emptyRow(8);
  $("billing-table").innerHTML = h + "</tbody>";
  $("bill-foot").innerHTML = footHTML("billing", info, renderBilling);
  renderBillPanel();
}
function toggleBill(stmtId) { BILL.sel = BILL.sel === stmtId ? null : stmtId; renderBilling(); }
function closeBill() { BILL.sel = null; renderBilling(); }
function renderBillPanel() {
  var p = $("bill-panel");
  var s = BILL.sel && LIVE.statements.filter(function (x) { return x.id === BILL.sel; })[0];
  $("bill-split").classList.toggle("open", !!s);
  if (!s) { p.innerHTML = ""; return; }

  var c = s.c;
  var clientStmts = LIVE.statements.filter(function (x) { return x.acc === c.no; });
  var hist = clientStmts.map(function (x) {
    return "<tr class='" + (x.id === s.id ? "cur" : "") + "'><td>" + monShort(x.month) + "</td><td>" + esc(x.inv) + "</td><td>" + peso(x.amount) + "</td><td>" + peso(x.paid) + "</td><td>" + badgeFor(x.pay) + "</td><td>" + badgeFor(x.send) + "</td></tr>";
  }).join("");

  var stmtPays = LIVE.payments.filter(function (r) { return r.statement_id === s.id || (r.acc === c.no && r.month === s.month); });
  var payRows = stmtPays.length ? stmtPays.map(function (r) {
    return "<tr><td>" + fmtD(r.date, 1) + "</td><td>" + esc(r.method) + "</td><td>" + (r.ref ? fmtRef(r.ref) : "") + "</td><td>" + esc(r.or || "") + "</td><td>" + peso(r.amount) + "</td><td>" + badgeFor(r.status) + "</td></tr>";
  }).join("") : "<tr><td colspan='6' style='color:#888;font-style:italic'>No payments recorded for this statement yet.</td></tr>";

  var canSend = s.send !== "Delivered";
  p.innerHTML = "<div class='bpn-head'><div><h3>" + esc(c.name) + "<span>" + esc(c.no) + "</span></h3><p>" + monShort(s.month) + " &middot; " + esc(c.plan) + " &middot; Due " + fmtD(s.due) + "</p><div class='tags'>" + badgeFor(s.pay) + badgeFor(s.send) + "</div></div><button class='x' title='Close' onclick='closeBill()'>&times;</button></div>" +
    "<div class='bpn-body'><div class='bpn-meta'><div><small>Invoice no.</small><b>" + esc(s.inv) + "</b></div><div><small>Billing date</small><b>" + fmtD(s.bill) + "</b></div><div><small>Due date</small><b>" + fmtD(s.due) + "</b></div><div><small>Branch</small><b>" + esc(c.branch) + "</b></div><div><small>Plan</small><b>" + esc(c.plan) + "</b></div><div><small>Account status</small><b>" + esc(c.status) + "</b></div></div>" +
    "<div class='stmt'><div class='top'><div><h4>FiberTec IT Solutions</h4><div class='tag'>E - STATEMENT</div></div><div style='text-align:right'><b style='font-size:16px'>" + esc(s.inv) + "</b><br><span class='muted'>Issued " + fmtD(s.bill) + "</span></div></div><hr>" +
    "<div class='h'><span>BILL TO</span></div><div class='acc'><div><b style='color:#000'>" + esc(c.name.toUpperCase()) + "</b><br>" + esc(c.address) + "</div><div><span class='h' style='display:block'>ACCOUNT</span>" + esc(c.no) + "<br><span class='muted'>" + esc(c.branch.toUpperCase()) + " BRANCH</span><br><span class='muted'>" + esc(c.email) + "</span></div></div><hr class='l'>" +
    "<div class='h'><span>DESCRIPTION</span><span>AMOUNT</span></div><div class='ln'><span>" + esc(c.plan.toUpperCase()) + "<small>Due " + fmtD(s.due, 1).toUpperCase() + "</small></span><span>" + peso(s.amount) + "</span></div><hr class='l'>" +
    "<div class='h'><span>PAID</span><span style='color:#000;font-size:13.5px;font-weight:500;letter-spacing:0'>" + peso(s.paid) + "</span></div><hr style='margin-top:10px'><div class='tot'><span>Total amount due</span><span>" + peso(s.balance) + "</span></div></div>" +
    "<div class='bpn-h'>Payments for this statement</div><table class='bpn-tbl'><thead><tr><th>Date</th><th>Method</th><th>Ref No.</th><th>O.R. No.</th><th>Amount</th><th>Status</th></tr></thead><tbody>" + payRows + "</tbody></table>" +
    "<div class='bpn-h'>Billing history</div><table class='bpn-tbl'><thead><tr><th>Period</th><th>Invoice</th><th>Amount</th><th>Paid</th><th>Payment Status</th><th>Status</th></tr></thead><tbody>" + hist + "</tbody></table>" +
    "<div class='bpn-actions'>" + (canSend ? "<button class='btn btn-blue' onclick='sendStatementLive(" + s.id + ")'>" + (s.send === "Failed" ? "Resend statement" : "Send statement now") + "</button>" : "") + "<button class='btn btn-light' onclick='viewClient(\"" + esc(c.no) + "\")'>View client</button></div></div>";
}

async function sendStatementLive(stmtId) {
  try {
    toast("Sending statement via Brevo...");
    var res = await adminApi("/statements/" + stmtId + "/send", { method: "POST" });
    await syncAdminData();
    renderBilling();
    toast(res.delivered ? "Statement delivered via email." : "Email delivery failed (check Brevo settings).");
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- Payments ---------- */
function payRows() {
  var m = val("p-month"), b = val("p-branch"), me = val("p-method"), st = val("p-status"), q = val("p-search").trim().toLowerCase();
  var base = livePayments(m, b).filter(function (r) {
    return !q || (r.acc + " " + r.name + " " + r.ref + " " + r.or).toLowerCase().indexOf(q) >= 0;
  });
  return {
    base: base,
    rows: base.filter(function (r) { return (!me || r.method === me) && (!st || r.status === st); })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b._o - a._o; })
  };
}
function onPayFilter() { pgReset("pay"); renderPayments(); }
function renderPayments() {
  var r = payRows(), ver = r.base.filter(function (x) { return x.status === "Verified"; }), pend = r.base.filter(function (x) { return x.status === "Pending"; });
  $("p-stats").innerHTML =
    '<div class="stat" style="background:#3167bd"><b>Total Collections Verified</b><span>' + peso(liveSumVerified(r.base)) + '</span></div>' +
    '<div class="stat" style="background:#5197d7"><b>Verified Payments</b><span>' + ver.length + '</span></div>' +
    '<div class="stat" style="background:#2daea6"><b>Pending Verification</b><span>' + pend.length + '</span></div>';

  var info = paginate("pay", r.rows);
  var h = "<thead><tr><th>Date</th><th>Reference No.</th><th>O.R. No.</th><th>Account No.</th><th>Client Name</th><th>Branch</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead><tbody>";
  info.rows.forEach(function (x) {
    h += "<tr><td>" + fmtD(x.date) + "</td><td>" + (x.ref ? fmtRef(x.ref) : "") + "</td><td>" + esc(x.or || "") + "</td><td>" + esc(x.acc) + "</td><td>" + esc(x.name) + "</td><td>" + esc(x.branch) + "</td><td>" + peso(x.amount) + "</td><td>" + esc(x.method) + "</td><td>" + badgeFor(x.status) + "</td></tr>";
  });
  if (!r.rows.length) h += emptyRow(9);
  $("pay-table").innerHTML = h + "</tbody>";
  $("pay-foot").innerHTML = footHTML("pay", info, renderPayments);
}

/* ---------- Branch analytics ---------- */
function renderAnalytics() {
  var b = val("a-branch"), m = val("a-month") || new Date().toISOString().slice(0, 7), names = branchScope("a-branch"), cl = liveClients(b);
  var stm = liveStatements(m, b), billed = 0, deliv = 0;
  stm.forEach(function (s) { billed += s.amount; if (s.send === "Delivered") deliv++; });
  var coll = liveSumVerified(livePayments(m, b));

  $("an-stats").innerHTML =
    '<div class="stat" style="background:#013f70"><b>Total Revenue (verified payments)</b><span>' + peso(coll) + '</span></div>' +
    '<div class="stat" style="background:#5197d7"><b>Collection Rate</b><span>' + pct(coll, billed) + '%</span><small>' + peso(coll) + ' of ' + peso(billed) + '</small></div>' +
    '<div class="stat" style="background:#2daea6"><b>Billing Completion Rate</b><span>' + pct(deliv, stm.length) + '%</span><small>' + deliv + ' of ' + stm.length + ' statements delivered</small></div>';

  var bl = [], co = [];
  names.forEach(function (bn) {
    var t = 0;
    liveStatements(m, bn).forEach(function (s) { t += s.amount; });
    bl.push(t);
    co.push(liveSumVerified(livePayments(m, bn)));
  });
  barChart({
    id: "an-chart",
    labels: names,
    h: 230,
    fmt: pesoPlainK,
    sub: monthLabel(m),
    series: [
      { name: "Billed", color: C_BILLED, vals: bl, exact: pesoPlain },
      { name: "Collected", color: C_COLL, vals: co, exact: pesoPlain }
    ],
    extra: function (i) { return "Collection rate: <b>" + pct(co[i], bl[i]) + "%</b>"; }
  });

  var planNames = [];
  cl.forEach(function (c) { if (c.plan && planNames.indexOf(c.plan) < 0) planNames.push(c.plan); });
  if (!planNames.length) planNames = ["Fiber 100 Mbps", "Fiber 200 Mbps", "Fiber 300 Mbps", "Fiber 500 Mbps"];
  var cols = ["#1b7a8a", "#0d4f7a", "#f5a623", "#8fb8d0"];
  var pv = planNames.map(function (pn) { return cl.filter(function (c) { return c.plan === pn; }).length; });
  var lg = "";
  planNames.forEach(function (pn, i) {
    lg += "<p><i style='background:" + cols[i % cols.length] + "'></i>" + esc(pn) + "<span>" + pv[i] + " (" + pct(pv[i], cl.length) + "%)</span></p>";
  });
  setDonut("plan-donut", pv, cols);
  $("plan-n").innerHTML = cl.length + "<small>clients</small>";
  $("plan-legend").innerHTML = lg + "<p class='total'>Total<span>" + cl.length + "</span></p>";

  var reg = [], churn = [];
  names.forEach(function (bn) {
    var bc = liveClients(bn);
    reg.push(bc.filter(function (c) { return c.status === "Active"; }).length);
    churn.push(pct(bc.filter(function (c) { return c.status === "Terminated"; }).length, bc.length));
  });
  barChart({ id: "reg-chart", labels: names, h: 160, fmt: function (v) { return Math.round(v); }, sub: "Active subscribers by branch", series: [{ name: "Active clients", color: C_BILLED, vals: reg }] });
  barChart({ id: "churn-chart", labels: names, h: 160, fmt: function (v) { return Math.round(v * 10) / 10 + "%"; }, sub: "Terminated accounts / all clients", series: [{ name: "Cancellation rate", color: "#d74548", vals: churn, exact: function (v) { return v + "%"; } }] });
}

/* ---------- Email & portal notifications ---------- */
function noticeRows(skipTab) {
  var q = val("n-search").trim().toLowerCase(), b = val("n-branch"), ty = val("n-type"), st = val("n-status");
  return LIVE.notices.filter(function (n) {
    if (!skipTab && NT.tab === "Emails" && n.channel !== "Email") return false;
    if (!skipTab && NT.tab === "Portal Notifications" && n.channel !== "Portal Notification") return false;
    return (!b || n.branch === b) && (!ty || n.type === ty) && (!st || n.status === st) && (!q || (n.acc + " " + n.name + " " + n.recipient).toLowerCase().indexOf(q) >= 0);
  });
}
function onNoticeFilter() { pgReset("notice"); renderNotices(); }
function setNoticeTab(t) { NT.tab = t; pgReset("notice"); renderNotices(); }
function renderNotices() {
  var all = LIVE.notices, base = noticeRows(true), rows = noticeRows(false), em = 0, po = 0, fl = 0;
  all.forEach(function (n) {
    if (n.channel === "Email" && n.status === "Sent") em++;
    if (n.channel === "Portal Notification") po++;
    if (n.status === "Failed") fl++;
  });
  $("n-stats").innerHTML =
    '<div class="stat" style="background:#00417c"><b>Total Notifications</b><span>' + all.length + '</span></div>' +
    '<div class="stat" style="background:#5197d7"><b>Emails Sent</b><span>' + em + '</span></div>' +
    '<div class="stat" style="background:#3167bd"><b>Portal Notifications</b><span>' + po + '</span></div>' +
    '<div class="stat" style="background:#d74548"><b>Failed Deliveries</b><span>' + fl + '</span></div>';

  var t = "";
  ["All", "Emails", "Portal Notifications"].forEach(function (tb) {
    var n = base.filter(function (x) {
      return tb === "All" || (tb === "Emails" ? x.channel === "Email" : x.channel === "Portal Notification");
    }).length;
    t += "<button class='" + (tb === NT.tab ? "active" : "") + "' onclick='setNoticeTab(\"" + tb + "\")'>" + tb + "<em>" + n + "</em></button>";
  });
  $("notif-tabs").innerHTML = t;

  var info = paginate("notice", rows);
  var h = "<thead><tr><th>Date Sent</th><th>Account No.</th><th>Client Name</th><th>Channel</th><th>Recipient / Destination</th><th>Notice Type</th><th>Status</th><th>Action</th></tr></thead><tbody>";
  info.rows.forEach(function (n) {
    h += "<tr><td>" + fmtD(n.date) + "</td><td>" + esc(n.acc) + "</td><td>" + esc(n.name) + "</td><td><b>" + esc(n.channel) + "</b></td><td>" + esc(n.recipient) + "</td><td>" + esc(n.type) + "</td><td>" + badgeFor(n.status) + "</td><td>" + (n.status === "Failed" ? "<button class='action' onclick='resendNoticeLive(" + n.id + ")'>Resend</button>" : "") + "</td></tr>";
  });
  if (!rows.length) h += emptyRow(8);
  $("email-table").innerHTML = h + "</tbody>";
  $("notice-foot").innerHTML = footHTML("notice", info, renderNotices);
}

async function resendNoticeLive(noticeId) {
  try {
    toast("Resending notice...");
    var res = await adminApi("/notices/" + noticeId + "/resend", { method: "POST" });
    await syncAdminData();
    renderNotices();
    toast(res.delivered ? "Notice resent successfully." : "Resend failed.");
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- Expand Card Overlay ---------- */
function expandCard(btn) {
  var card = btn.closest(".dcard");
  if (!card) return;
  var clonedCard = card.cloneNode(true);
  var expBtn = clonedCard.querySelector(".expand-btn");
  if (expBtn) {
    expBtn.outerHTML = '<button class="x" style="margin-left:auto; cursor:pointer; font-size:28px; border:0; background:none; color:#002f6e; font-weight:bold;" onclick="closeModal()">&times;</button>';
  }
  var modal = modal2(clonedCard.outerHTML, "");
  modal.style.padding = "0";
  modal.style.alignItems = "flex-start";
  var dlg = modal.querySelector(".dlg");
  if (dlg) {
    dlg.style.position = "fixed";
    dlg.style.top = "90px";
    dlg.style.left = "270px";
    dlg.style.right = "24px";
    dlg.style.bottom = "20px";
    dlg.style.width = "auto";
    dlg.style.maxWidth = "none";
    dlg.style.height = "auto";
    dlg.style.maxHeight = "none";
    dlg.style.margin = "0";
    dlg.style.padding = "24px";
    dlg.style.background = "#fff";
    dlg.style.borderRadius = "12px";
    dlg.style.boxShadow = "0 10px 40px rgba(0,0,0,0.4)";
    dlg.style.display = "flex";
    dlg.style.flexDirection = "column";
    dlg.style.overflow = "auto";
  }
  growIn(modal);
}

/* ---------- start ---------- */
async function startAdmin() {
  try {
    await syncAdminData();
  } catch (e) {
    toast("Failed to load live database records: " + e.message);
  }
  var br = branchScope("");
  ["d-branch", "b-branch", "p-branch", "a-branch", "n-branch"].forEach(function (id) { fillSelect(id, "All Branches", br); });
  var curYm = new Date().toISOString().slice(0, 7);
  var months = monthItems();
  if (!months.some(function (x) { return x.k === curYm; })) {
    months.unshift({ k: curYm, l: monthLabel(curYm) });
  }
  ["d-month", "b-month", "a-month"].forEach(function (id) { fillSelect(id, "", months); });
  fillSelect("p-month", "All Months", months);
  fillSelect("b-status", "All Status", ["Delivered", "Not Yet Sent", "Failed"]);
  fillSelect("p-method", "All Methods", ["GCash", "Cash"]);
  fillSelect("p-status", "All Statuses", ["Pending", "Verified", "Rejected"]);
  fillSelect("n-type", "All Notice Types", ["7-Day Billing Notice", "Disconnection Warning", "Payment Receipt", "System Notice"]);
  fillSelect("n-status", "All Status", ["Sent", "Not Yet Sent", "Failed"]);
  if (typeof initClientsView === "function") initClientsView();
  renderDash();
}

if ($("d-stats") && requireRole("admin")) startAdmin();