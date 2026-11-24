/* FiberTec - Admin portal pages (Live Neon API integration) */
var ADMIN_PAGES = ["dash", "clients", "billing", "pay", "analytics", "email"];
var STATUS_COLORS = ["#4cb153", "#fde400", "#fdad00", "#ff5454"], C_BILLED = "#3167bd", C_COLL = "#2daea6";
var BILL = { sel: null }, NT = { tab: "All" };

var LIVE = {
  clients: [],
  statements: [],
  payments: [],
  notices: [],
  passwordResetRequests: [],
  months: [],
  loaded: false
};

var BRANCH_MAP = {
  "01": "Bagong Ilog",
  "02": "Caniogan",
  "03": "Palatiw",
  "04": "Maybunga Bliss 3",
  "05": "Maybunga Bliss 1",
  "06": "Nagpayong"
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

function getAuthToken() {
  var directKeys = ["token", "jwt", "authToken", "ft_token", "fibertec_token"];
  var stores = [window.localStorage, window.sessionStorage];

  for (var s = 0; s < stores.length; s++) {
    var store = stores[s];
    if (!store) continue;

    for (var i = 0; i < directKeys.length; i++) {
      var val = store.getItem(directKeys[i]);
      if (val && val.split(".").length === 3) return val;
    }

    for (var j = 0; j < store.length; j++) {
      var key = store.key(j);
      var raw = store.getItem(key);
      if (!raw) continue;
      if (raw.split(".").length === 3 && raw.indexOf("eyJ") === 0) return raw;
      if (raw.charAt(0) === "{") {
        try {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed.token === "string" && parsed.token.split(".").length === 3) {
            return parsed.token;
          }
        } catch (err) {}
      }
    }
  }
  return "";
}

async function adminApi(path, opts) {
  opts = opts || {};
  var token = getAuthToken();
  var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (token && !headers["Authorization"]) {
    headers["Authorization"] = "Bearer " + token;
  }

  var fetchOpts = Object.assign({ credentials: "same-origin" }, opts, { headers: headers, cache: "no-store" });
  var res = await fetch("/api/admin" + path, fetchOpts);
  var data = await res.json().catch(function () { return {}; });
  if (res.status === 401) {
    redirectToLogin("session-expired");
    throw { status: 401, message: "Session expired. Please log in again." };
  }
  if (res.status === 403 && data.mustChangePassword) {
    redirectToLogin("password-reset");
    throw { status: 401, message: data.error || "Your password was reset. Sign in again to set a new password." };
  }
  if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
  return data;
}

async function syncAdminData() {
  var results = await Promise.all([
    adminApi("/clients"),
    adminApi("/statements"),
    adminApi("/payments"),
    adminApi("/notices"),
    adminApi("/months"),
    adminApi("/password-reset-requests")
  ]);

  LIVE.clients = results[0].map(function (c) {
    return {
      no: c.account_no,
      name: c.name,
      contact: c.contact_no || "",
      branch: c.branch,
      branch_code: branchCodeForName(c.branch),
      plan_id: c.plan_id,
      plan: c.plan_name,
      facebook: c.facebook || "",
      router_location: c.router_location || "",
      current_balance: Number(c.current_balance || 0),
      outstanding_balance: Number(c.outstanding_balance || 0),
      payment_status: c.payment_status || "—",
      has_pending_payment: !!c.has_pending_payment,
      current_due_date: c.current_due_date || "",
      status: c.status,
      status_reason: c.status_reason || "",
      due_day: c.due_day,
      flagged_date: c.flagged_date || "",
      overdue_due_date: c.overdue_due_date || "",
      grace_end_date: c.grace_end_date || "",
      registered_date: c.registered_date || "",
      termination_date: c.termination_date || "",
      created_month: c.created_month || String(c.registered_date || c.created_at || c.installed_date || "").slice(0, 7),
      terminated_month: c.status === "Terminated" ? (c.terminated_month || String(c.termination_date || c.updated_at || "").slice(0, 7)) : "",
      email: c.email || "",
      address: c.address || "",
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
      plan: "",
      status: "—",
      created_month: "",
      terminated_month: "",
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
      bill: String(s.issued_date || "").slice(0, 10),
      due: String(s.due_date || "").slice(0, 10),
      amount: Number(s.amount || 0),
      paid: Number(s.amount_paid || 0),
      balance: Number(s.balance || 0),
      pay: s.payment_status || "—",
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
      method: p.payment_method || p.method || "",
      ref: p.reference_no || p.ref_no || "",
      or: p.or_no || p.official_receipt || "",
      status: p.status || "—"
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

  LIVE.passwordResetRequests = results[5];
  LIVE.months = results[4];
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
  ACTIVE_ADMIN_PAGE = id;
  var monthId = { dash: "d-month", billing: "b-month", analytics: "a-month" }[id];
  if (monthId) $(monthId).value = new Date().toISOString().slice(0, 7);
  try {
    await syncAdminData();
  } catch (e) {
    toast("Database sync warning: " + e.message);
  }
  updatePasswordResetBadge();
  await ({ dash: renderDash, clients: renderClients, billing: renderBilling, pay: renderPayments, analytics: renderAnalytics, email: renderNotices })[id]();
  ADMIN_RENDERED_SIGNATURE = adminDataSignature();
}
function pct(a, b) {
  a = Number(a); b = Number(b);
  return isFinite(a) && isFinite(b) && b > 0 ? Math.round(a / b * 1000) / 10 : 0;
}
var ACTIVE_ADMIN_PAGE = "dash", DASH_REQUEST = 0, ANALYTICS_REQUEST = 0;
var ADMIN_CANCEL_REQUEST = 0, ADMIN_CANCEL_POLL = null, ADMIN_CANCEL_SIGNATURE = "", ADMIN_POLL_RUNNING = false, ADMIN_RENDERED_SIGNATURE = "";
function adminDataSignature() {
  return JSON.stringify([LIVE.clients, LIVE.statements, LIVE.payments, LIVE.notices, LIVE.passwordResetRequests, LIVE.months]);
}
function branchScope(id) {
  var b = val(id);
  if (b) return [b];
  var names = Object.keys(BRANCH_MAP).sort().map(function (k) { return BRANCH_MAP[k]; });
  LIVE.clients.forEach(function (c) { if (c.branch && names.indexOf(c.branch) < 0) names.push(c.branch); });
  return names;
}

/* ---------- Dashboard ---------- */
async function renderDash(isLivePoll) {
  var request = ++DASH_REQUEST, b = val("d-branch"), m = val("d-month");
  if (!isLivePoll) {
    ["d-stats", "branch-bars", "status-legend", "recent-pay"].forEach(function (id) { $(id).innerHTML = ""; });
    $("dash-chart").innerHTML = "";
    $("donut-n").innerHTML = "";
    setDonut("status-donut", [0, 0, 0, 0], STATUS_COLORS);
  }
  refreshAdminCancellations(!isLivePoll);
  if (!ADMIN_CANCEL_POLL) {
    ADMIN_CANCEL_POLL = setInterval(function () {
      if (!liveRefreshPaused() && ACTIVE_ADMIN_PAGE === "dash") refreshAdminCancellations();
    }, 3000);
  }
  try {
    var data = await adminApi("/dashboard" + periodQuery(m, b));
    if (request !== DASH_REQUEST || (isLivePoll && liveRefreshPaused())) return false;
    var branches = data.branches || [], names = branches.map(function (x) { return x.branch; });
    var cnt = { Active: 0, "Grace Period": 0, "Under Review": 0, Terminated: 0 };
    (data.statuses || []).forEach(function (x) { if (cnt[x.status] !== undefined) cnt[x.status] = Number(x.count); });
    var clients = branches.reduce(function (a, x) { return a + Number(x.clients); }, 0);
    var billed = branches.reduce(function (a, x) { return a + Number(x.billed); }, 0);
    var coll = branches.reduce(function (a, x) { return a + Number(x.collected); }, 0), out = Math.max(0, billed - coll);

    $("d-stats").innerHTML =
      '<div class="stat" style="background:#00417c"><b>Total Clients</b><span>' + clients + '</span><small>' + cnt.Active + ' active + ' + cnt["Grace Period"] + ' grace + ' + cnt["Under Review"] + ' review + ' + cnt.Terminated + ' terminated</small></div>' +
      '<div class="stat" style="background:#5197d7"><b>Total Billed amount</b><span>' + peso(billed) + '</span><small>' + branches.reduce(function (a, x) { return a + Number(x.statements); }, 0) + ' statements</small></div>' +
      '<div class="stat" style="background:#3167bd"><b>Total Collections Verified</b><span>' + peso(coll) + '</span><small>' + pct(coll, billed) + '% of billed</small></div>' +
      '<div class="stat" style="background:#2daea6"><b>Total Outstanding Receivables</b><span>' + peso(out) + '</span><small>' + pct(out, billed) + '% of billed</small></div>';

    var rows = "", tc = 0, ta = 0, tb = 0, tcol = 0;
    branches.forEach(function (x) {
      var p = Number(x.collection_efficiency), clientsInBranch = Number(x.clients), active = Number(x.active);
      tc += clientsInBranch; ta += active; tb += Number(x.billed); tcol += Number(x.collected);
      rows += "<tr><td>" + esc(x.branch) + "</td><td><div class='track' title='" + p + "% collected'><i style='width:0' data-w='" + Math.min(100, p) + "%'></i></div></td><td>" + clientsInBranch + "</td><td>" + active + "</td><td>" + p + "%</td></tr>";
    });
    $("branch-bars").innerHTML = "<table class='bp'><thead><tr><th>Branch</th><th>Billing Cycle Progress</th><th>Clients</th><th>Active</th><th>Collected</th></tr></thead><tbody>" + rows + "</tbody><tfoot><tr><td>Total</td><td></td><td>" + tc + "</td><td>" + ta + "</td><td>" + pct(tcol, tb) + "%</td></tr></tfoot></table>";
    growIn($("branch-bars"));

    var vals = STATUSES.map(function (s) { return cnt[s] || 0; }), lg = "";
    STATUSES.forEach(function (s, i) { lg += "<p><i style='background:" + STATUS_COLORS[i] + "'></i>" + s + "<span>" + vals[i] + "</span></p>"; });
    setDonut("status-donut", vals, STATUS_COLORS);
    $("donut-n").innerHTML = clients + "<small>clients</small>";
    $("status-legend").innerHTML = lg + "<p class='total'>Total<span>" + clients + "</span></p>";

    var bl = branches.map(function (x) { return Number(x.billed); }), co = branches.map(function (x) { return Number(x.collected); });
    barChart({
      id: "dash-chart", labels: names, h: 210, fmt: pesoPlainK, sub: monthLabel(m),
      series: [
        { name: "Billed", color: C_BILLED, vals: bl, exact: function (v) { return pesoPlain(v); } },
        { name: "Collected", color: C_COLL, vals: co, exact: function (v) { return pesoPlain(v); } }
      ],
      extra: function (i) { return "Collection rate: <b>" + pct(co[i], bl[i]) + "%</b> &middot; Outstanding: " + pesoPlain(Math.max(0, bl[i] - co[i])); }
    });

    var rp = data.recent_payments || [];
    var h = "<thead><tr><th>Date</th><th>Client Name</th><th>Amount</th><th>Status</th></tr></thead><tbody>";
    rp.forEach(function (r) {
      h += "<tr><td>" + fmtD(r.payment_date) + "</td><td>" + esc(r.name) + "</td><td>" + peso(r.amount) + "</td><td>" + badgeFor(r.status) + "</td></tr>";
    });
    $("recent-pay").innerHTML = h + (rp.length ? "" : "<tr><td colspan='4' class='muted'>No payments for this selection.</td></tr>") + "</tbody>";
    return true;
  } catch (e) {
    if (request === DASH_REQUEST) {
      if (isLivePoll) console.error("[admin dashboard refresh]", e);
      else toast("Dashboard data could not be loaded: " + e.message, "error");
    }
    return false;
  }
}

async function refreshAdminCancellations(force) {
  if (!force && liveRefreshPaused()) return;
  var el = $("dash-cancellations");
  if (!el) return;
  var request = ++ADMIN_CANCEL_REQUEST, branch = val("d-branch");
  var branchCode = branch ? branchCodeForName(branch) : "";
  var path = "/cancellations" + (branchCode ? "?branch=" + encodeURIComponent(branchCode) : "");
  try {
    var rows = await adminApi(path);
    if (request !== ADMIN_CANCEL_REQUEST || (!force && liveRefreshPaused())) return;
    var pending = rows.filter(function (r) { return r.status === "Pending"; });
    var signature = JSON.stringify(pending);
    if (signature === ADMIN_CANCEL_SIGNATURE) return;
    ADMIN_CANCEL_SIGNATURE = signature;
    $("admin-req-count").textContent = pending.length;
    el.innerHTML = pending.length
      ? pending.map(function (r) {
        return "<div class='row-line'><span><b>" + esc(r.name) + "</b> (" + esc(r.account_no) + ")" +
          "<small>" + esc(r.branch) + " &middot; Requested " + fmtD(r.request_date) + " &middot; " + esc(r.reason) + "</small></span>" +
          "<span class='badge orange'>Pending</span></div>";
      }).join("")
      : "<p class='empty'>No pending cancellation requests.</p>";
  } catch (e) {
    if (request === ADMIN_CANCEL_REQUEST) console.error("[admin cancellation refresh]", e);
  }
}
function pesoPlainK(v) { return v >= 1000 ? "\u20B1" + (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "K" : "\u20B1" + v; }
function periodQuery(month, branchName) {
  var params = [];
  if (month) params.push("month=" + encodeURIComponent(month));
  if (branchName) params.push("branch=" + encodeURIComponent(branchCodeForName(branchName)));
  return params.length ? "?" + params.join("&") : "";
}
function populateMonthFilters(defaultCurrent) {
  var months = monthItems(), current = new Date().toISOString().slice(0, 7);
  ["d-month", "b-month", "p-month", "a-month"].forEach(function (id) {
    var selected = val(id);
    fillSelect(id, "All Months", months);
    var available = months.some(function (item) { return item.v === selected; });
    $(id).value = available ? selected : (id === "p-month" || !defaultCurrent ? "" : current);
  });
}

/* ---------- Billing ---------- */
function billRows() {
  var m = val("b-month"), b = val("b-branch"), st = val("b-status"), q = val("b-search").trim().toLowerCase();
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
  var m = val("b-month"), r = billRows(), cnt = { Delivered: 0, "Not Yet Sent": 0, Failed: 0 };
  r.all.forEach(function (s) { if (cnt[s.send] !== undefined) cnt[s.send]++; });
  $("b-stats").innerHTML =
    '<div class="stat" style="background:#3167bd"><b>Total Statements</b><span>' + r.all.length + '</span></div>' +
    '<div class="stat" style="background:#81c715"><b>Delivered</b><span>' + cnt.Delivered + '</span></div>' +
    '<div class="stat" style="background:#10c3b8"><b>Not Yet Sent</b><span>' + cnt["Not Yet Sent"] + '</span></div>' +
    '<div class="stat" style="background:#d74548"><b>Failed</b><span>' + cnt.Failed + '</span></div>';
  $("bill-title").innerHTML = "BILLING FOR " + monthLabel(m).toUpperCase() + " <span class='muted'>(live database records)</span>";

  var info = paginate("billing", r.rows);
  var h = "<thead><tr><th>Invoice No.</th><th class='col-x'>Account No.</th><th>Client Name</th><th class='col-x'>Branch</th><th>Issued Date</th><th>Due Date</th><th>Amount Due</th><th>Status</th></tr></thead><tbody>";
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
    "<div class='bpn-body'><div class='bpn-meta'><div><small>Invoice no.</small><b>" + esc(s.inv) + "</b></div><div><small>Issued date</small><b>" + fmtD(s.bill) + "</b></div><div><small>Due date</small><b>" + fmtD(s.due) + "</b></div><div><small>Branch</small><b>" + esc(c.branch) + "</b></div><div><small>Plan</small><b>" + esc(c.plan) + "</b></div><div><small>Account status</small><b>" + esc(c.status) + "</b></div></div>" +
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

/* ---------- Exact F-Distribution & Statistical Helpers ---------- */
function logGamma(z) {
  var c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953
  ];
  var x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  var ser = 1.000000000190015;
  for (var j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betaCf(a, b, x) {
  var MAXIT = 100, EPS = 3e-7, FPMIN = 1e-30;
  var qab = a + b, qap = a + 1, qam = a - 1;
  var c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  var h = d;
  for (var m = 1; m <= MAXIT; m++) {
    var m2 = 2 * m;
    var aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    var del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function regIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  var bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betaCf(a, b, x) / a;
  return 1 - bt * betaCf(b, a, 1 - x) / b;
}

function fDistPValue(F, df1, df2) {
  if (!isFinite(F) || F <= 0 || df1 <= 0 || df2 <= 0) return 1;
  var x = df2 / (df2 + df1 * F);
  return Math.max(0.0001, Math.min(1, regIncompleteBeta(df2 / 2, df1 / 2, x)));
}

function renderAnovaCard(m, branchFilter) {
  var host = $("anova");
  if (!host) return;

  var allNames = branchScope("");
  var groups = allNames.map(function (bn) {
    var bc = liveClients(bn);
    var pays = livePayments(m, bn).filter(function (p) { return p.status === "Verified"; });
    var paidByAcc = {};
    pays.forEach(function (p) {
      paidByAcc[p.acc] = (paidByAcc[p.acc] || 0) + p.amount;
    });
    var values = bc.map(function (c) { return paidByAcc[c.no] || 0; });
    var sum = 0;
    values.forEach(function (v) { sum += v; });
    var n = values.length;
    var mean = n ? sum / n : 0;
    var ssWithin = 0;
    values.forEach(function (v) { ssWithin += Math.pow(v - mean, 2); });
    var variance = n > 1 ? ssWithin / (n - 1) : 0;
    return {
      branch: bn,
      n: n,
      sum: sum,
      mean: mean,
      variance: variance,
      sd: Math.sqrt(variance),
      ssWithin: ssWithin
    };
  }).filter(function (g) { return g.n > 0; });

  var totalN = 0, grandSum = 0;
  groups.forEach(function (g) { totalN += g.n; grandSum += g.sum; });
  var grandMean = totalN ? grandSum / totalN : 0;

  var ssb = 0, ssw = 0;
  groups.forEach(function (g) {
    ssb += g.n * Math.pow(g.mean - grandMean, 2);
    ssw += g.ssWithin;
  });
  var sst = ssb + ssw;
  var k = groups.length;
  var dfb = Math.max(1, k - 1);
  var dfw = Math.max(1, totalN - k);
  var msb = ssb / dfb;
  var msw = ssw / dfw;
  var fStat = msw > 0 ? msb / msw : 0;
  var pVal = fDistPValue(fStat, dfb, dfw);
  var sig = pVal < 0.05;

  var rows = groups.map(function (g) {
    var hl = branchFilter && branchFilter === g.branch ? " style='background:#eef6ff;font-weight:600'" : "";
    return "<tr" + hl + ">" +
      "<td><b>" + esc(g.branch) + "</b></td>" +
      "<td>" + g.n + "</td>" +
      "<td>" + peso(g.mean) + "</td>" +
      "<td>" + peso(g.sd) + "</td>" +
      "<td>" + peso(g.sum) + "</td>" +
    "</tr>";
  }).join("");

  host.innerHTML =
    "<div style='display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 12px'>" +
      "<div style='flex:1;min-width:110px;background:#f4f8fc;border-left:4px solid #00417c;padding:8px 10px;border-radius:6px'>" +
        "<div style='font-size:11px;color:#5a6b82;text-transform:uppercase'>F-Statistic</div>" +
        "<div style='font-size:18px;font-weight:700;color:#002f6e'>" + fStat.toFixed(3) + "</div>" +
      "</div>" +
      "<div style='flex:1;min-width:110px;background:#f4f8fc;border-left:4px solid #2daea6;padding:8px 10px;border-radius:6px'>" +
        "<div style='font-size:11px;color:#5a6b82;text-transform:uppercase'>p-Value (&alpha; = 0.05)</div>" +
        "<div style='font-size:18px;font-weight:700;color:#002f6e'>" + (pVal < 0.001 ? "&lt; 0.001" : pVal.toFixed(4)) + "</div>" +
      "</div>" +
      "<div style='flex:1;min-width:130px;background:#f4f8fc;border-left:4px solid " + (sig ? "#d74548" : "#4cb153") + ";padding:8px 10px;border-radius:6px'>" +
        "<div style='font-size:11px;color:#5a6b82;text-transform:uppercase'>Decision</div>" +
        "<div style='font-size:13px;font-weight:700;color:" + (sig ? "#b82528" : "#247a2b") + ";margin-top:3px'>" +
          (sig ? "Significant Difference" : "No Significant Difference") +
        "</div>" +
      "</div>" +
    "</div>" +
    "<p style='font-size:12px;color:#4a5a70;margin:0 0 10px;line-height:1.45'>" +
      "One-Way ANOVA on verified collections per subscriber in <b>" + monthLabel(m) + "</b> across <b>" + k + " branches</b> (N = " + totalN + ", Grand Mean = <b>" + peso(grandMean) + "</b>). " +
      (sig
        ? "Since <i>p</i> &lt; 0.05, mean verified revenue per client differs significantly across branches."
        : "Since <i>p</i> &ge; 0.05, mean verified revenue per client is statistically consistent across branches.") +
    "</p>" +
    "<div style='overflow-x:auto'>" +
      "<table class='bp' style='width:100%;font-size:12px;margin-bottom:10px'>" +
        "<thead><tr><th>Source of Variation</th><th>SS</th><th>df</th><th>MS</th><th>F</th><th>p-value</th></tr></thead>" +
        "<tbody>" +
          "<tr><td>Between Branches</td><td>" + pesoPlain(ssb) + "</td><td>" + dfb + "</td><td>" + pesoPlain(msb) + "</td><td><b>" + fStat.toFixed(3) + "</b></td><td>" + (pVal < 0.001 ? "&lt; 0.001" : pVal.toFixed(4)) + "</td></tr>" +
          "<tr><td>Within Branches</td><td>" + pesoPlain(ssw) + "</td><td>" + dfw + "</td><td>" + pesoPlain(msw) + "</td><td>&mdash;</td><td>&mdash;</td></tr>" +
        "</tbody>" +
        "<tfoot><tr><td>Total</td><td>" + pesoPlain(sst) + "</td><td>" + (dfb + dfw) + "</td><td>&mdash;</td><td>&mdash;</td><td>&mdash;</td></tr></tfoot>" +
      "</table>" +
      "<table class='bp' style='width:100%;font-size:12px'>" +
        "<thead><tr><th>Branch</th><th>Clients (n)</th><th>Mean / Client</th><th>Std. Dev.</th><th>Verified Total</th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table>" +
    "</div>";
}

function renderMarkovCard(m, branchFilter) {
  var host = $("markov");
  if (!host) return;

  var cl = liveClients(branchFilter);
  var cnt = liveStatusCounts(cl);
  var stm = liveStatements(m, branchFilter);
  var total = Math.max(1, cl.length);

  var paidCount = 0;
  stm.forEach(function (s) {
    if (s.pay === "Paid") paidCount++;
  });
  var stmTotal = Math.max(1, stm.length);
  var collectionRatio = paidCount / stmTotal;
  var graceShare = cnt["Grace Period"] / total;
  var reviewShare = cnt["Under Review"] / total;

  var pAG = Math.min(0.25, Math.max(0.05, Math.round((graceShare * 0.8 + (1 - collectionRatio) * 0.06) * 1000) / 1000));
  var pAR = Math.min(0.10, Math.max(0.01, Math.round((reviewShare * 0.4 + 0.01) * 1000) / 1000));
  var pAT = 0.005;
  var pAA = Math.max(0.5, Math.round((1 - pAG - pAR - pAT) * 1000) / 1000);

  var pGA = Math.min(0.75, Math.max(0.35, Math.round((0.40 + collectionRatio * 0.35) * 1000) / 1000));
  var pGG = Math.round((0.65 - pGA * 0.5) * 1000) / 1000;
  var pGT = 0.05;
  var pGR = Math.max(0.05, Math.round((1 - pGA - pGG - pGT) * 1000) / 1000);

  var pRA = Math.min(0.45, Math.max(0.15, Math.round((0.20 + collectionRatio * 0.25) * 1000) / 1000));
  var pRG = 0.12;
  var pRT = Math.min(0.40, Math.max(0.15, Math.round((0.35 - collectionRatio * 0.15) * 1000) / 1000));
  var pRR = Math.max(0.10, Math.round((1 - pRA - pRG - pRT) * 1000) / 1000);

  var states = ["Active", "Grace Period", "Under Review", "Terminated"];
  var matrix = [
    [pAA, pAG, pAR, pAT],
    [pGA, pGG, pGR, pGT],
    [pRA, pRG, pRR, pRT],
    [0.00, 0.00, 0.00, 1.00]
  ];

  var curr = [cnt.Active, cnt["Grace Period"], cnt["Under Review"], cnt.Terminated];
  var next = [0, 0, 0, 0];
  for (var i = 0; i < 4; i++) {
    for (var j = 0; j < 4; j++) {
      next[j] += curr[i] * matrix[i][j];
    }
  }
  var nextRounded = next.map(function (v) { return Math.round(v); });
  var expectedNewChurn = Math.max(0, nextRounded[3] - curr[3]);
  var atRiskBase = Math.max(1, curr[0] + curr[1] + curr[2]);
  var monthlyChurnRisk = pct(curr[0] * pAT + curr[1] * pGT + curr[2] * pRT, atRiskBase);

  var mRows = states.map(function (st, rIdx) {
    var cells = matrix[rIdx].map(function (prob, cIdx) {
      var bg = rIdx === cIdx ? " style='background:#eef6ff;font-weight:700;color:#002f6e'" : (cIdx === 3 && prob > 0 ? " style='color:#b82528;font-weight:600'" : "");
      return "<td" + bg + ">" + (prob * 100).toFixed(1) + "%</td>";
    }).join("");
    return "<tr><td><b>" + st + "</b> <span class='muted'>(" + curr[rIdx] + ")</span></td>" + cells + "</tr>";
  }).join("");

  var fRows = states.map(function (st, idx) {
    var diff = nextRounded[idx] - curr[idx];
    var sign = diff > 0 ? "+" + diff : String(diff);
    return "<tr><td><b>" + st + "</b></td><td>" + curr[idx] + "</td><td><b>" + nextRounded[idx] + "</b></td><td>" + sign + "</td></tr>";
  }).join("");

  host.innerHTML =
    "<div style='display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 12px'>" +
      "<div style='flex:1;min-width:120px;background:#f4f8fc;border-left:4px solid #4cb153;padding:8px 10px;border-radius:6px'>" +
        "<div style='font-size:11px;color:#5a6b82;text-transform:uppercase'>Active Retention</div>" +
        "<div style='font-size:18px;font-weight:700;color:#002f6e'>" + (pAA * 100).toFixed(1) + "%</div>" +
      "</div>" +
      "<div style='flex:1;min-width:120px;background:#f4f8fc;border-left:4px solid #fdad00;padding:8px 10px;border-radius:6px'>" +
        "<div style='font-size:11px;color:#5a6b82;text-transform:uppercase'>Grace Recovery</div>" +
        "<div style='font-size:18px;font-weight:700;color:#002f6e'>" + (pGA * 100).toFixed(1) + "%</div>" +
      "</div>" +
      "<div style='flex:1;min-width:120px;background:#f4f8fc;border-left:4px solid #d74548;padding:8px 10px;border-radius:6px'>" +
        "<div style='font-size:11px;color:#5a6b82;text-transform:uppercase'>Projected Churn Rate</div>" +
        "<div style='font-size:18px;font-weight:700;color:#b82528'>" + monthlyChurnRisk + "% <small style='font-size:11px;font-weight:500'>(~" + expectedNewChurn + " acct)</small></div>" +
      "</div>" +
    "</div>" +
    "<p style='font-size:12px;color:#4a5a70;margin:0 0 10px;line-height:1.45'>" +
      "4-state absorbing Markov Chain calibrated from <b>" + (branchFilter || "All Branches") + "</b> (" + monthLabel(m) + " paid rate: <b>" + pct(paidCount, stmTotal) + "%</b>; <i>P</i><sub>TT</sub> = 100%)." +
    "</p>" +
    "<div style='overflow-x:auto'>" +
      "<table class='bp' style='width:100%;font-size:12px;margin-bottom:10px'>" +
        "<thead><tr><th>Current State (n)</th><th>&rarr; Active</th><th>&rarr; Grace</th><th>&rarr; Review</th><th>&rarr; Terminated</th></tr></thead>" +
        "<tbody>" + mRows + "</tbody>" +
      "</table>" +
      "<table class='bp' style='width:100%;font-size:12px'>" +
        "<thead><tr><th>Account State</th><th>Current Count</th><th>Next-Month Forecast</th><th>Net Change</th></tr></thead>" +
        "<tbody>" + fRows + "</tbody>" +
      "</table>" +
    "</div>";
}

/* ---------- Branch analytics ---------- */
async function renderAnalytics(isLivePoll) {
  var request = ++ANALYTICS_REQUEST, b = val("a-branch"), m = val("a-month"), cl = liveClients(b);
  if (!isLivePoll) {
    ["an-stats", "plan-legend", "anova", "markov"].forEach(function (id) { $(id).innerHTML = ""; });
    ["an-chart", "reg-chart", "churn-chart"].forEach(function (id) { $(id).innerHTML = ""; });
    $("plan-n").innerHTML = "";
    setDonut("plan-donut", [0, 0, 0, 0], ["#1b7a8a", "#0d4f7a", "#f5a623", "#8fb8d0"]);
  }
  try {
    var data = await adminApi("/analytics" + periodQuery(m, b));
    if (request !== ANALYTICS_REQUEST || (isLivePoll && liveRefreshPaused())) return false;
    var branches = data.branches || [], names = branches.map(function (x) { return x.branch; });
    var billed = branches.reduce(function (a, x) { return a + Number(x.billed); }, 0);
    var coll = branches.reduce(function (a, x) { return a + Number(x.collected); }, 0);
    var revenue = branches.reduce(function (a, x) { return a + Number(x.revenue); }, 0);
    var delivered = branches.reduce(function (a, x) { return a + Number(x.delivered); }, 0);
    var statementCount = branches.reduce(function (a, x) { return a + Number(x.statements); }, 0);

    $("an-stats").innerHTML =
      '<div class="stat" style="background:#013f70"><b>Total Revenue (verified payments)</b><span>' + peso(revenue) + '</span></div>' +
      '<div class="stat" style="background:#5197d7"><b>Collection Rate</b><span>' + pct(coll, billed) + '%</span><small>' + peso(coll) + ' of ' + peso(billed) + '</small></div>' +
      '<div class="stat" style="background:#2daea6"><b>Billing Completion Rate</b><span>' + pct(delivered, statementCount) + '%</span><small>' + delivered + ' of ' + statementCount + ' statements delivered</small></div>';

    var bl = branches.map(function (x) { return Number(x.billed); });
    var co = branches.map(function (x) { return Number(x.collected); });
    barChart({
      id: "an-chart", labels: names, h: 230, fmt: pesoPlainK, sub: monthLabel(m),
      series: [
        { name: "Billed", color: C_BILLED, vals: bl, exact: pesoPlain },
        { name: "Collected", color: C_COLL, vals: co, exact: pesoPlain }
      ],
      extra: function (i) { return "Collection rate: <b>" + pct(co[i], bl[i]) + "%</b>"; }
    });

  var planNames = [];
  cl.forEach(function (c) { if (c.plan && planNames.indexOf(c.plan) < 0) planNames.push(c.plan); });
  if (!planNames.length) planNames = ["LiteSpeed 50Mbps", "Turbo 110 Mbps", "Elite 150 Mbps", "Premium 220 Mbps"];
  var cols = ["#1b7a8a", "#0d4f7a", "#f5a623", "#8fb8d0"];
  var pv = planNames.map(function (pn) { return cl.filter(function (c) { return c.plan === pn; }).length; });
  var lg = "";
  planNames.forEach(function (pn, i) {
    lg += "<p><i style='background:" + cols[i % cols.length] + "'></i>" + esc(pn) + "<span>" + pv[i] + " (" + pct(pv[i], cl.length) + "%)</span></p>";
  });
  setDonut("plan-donut", pv, cols);
  $("plan-n").innerHTML = cl.length + "<small>clients</small>";
  $("plan-legend").innerHTML = lg + "<p class='total'>Total<span>" + cl.length + "</span></p>";

  var reg = branches.map(function (x) { return Number(x.registrations); });
  var churn = branches.map(function (x) { return pct(Number(x.cancellations), Number(x.clients)); });
  barChart({
    id: "reg-chart",
    labels: names,
    h: 160,
    fmt: function (v) { return Math.round(v); },
    sub: "New sign-ups in " + monthLabel(m),
    series: [{ name: "New registrations", color: C_BILLED, vals: reg }]
  });
  barChart({
    id: "churn-chart",
    labels: names,
    h: 160,
    fmt: function (v) { return Math.round(v * 10) / 10 + "%"; },
    sub: "Cancellations in " + monthLabel(m) + " / branch clients",
    series: [{ name: "Monthly cancellation rate", color: "#d74548", vals: churn, exact: function (v) { return v + "%"; } }]
  });

    renderAnovaCard(m, b);
    renderMarkovCard(m, b);
    return true;
  } catch (e) {
    if (request === ANALYTICS_REQUEST) {
      if (isLivePoll) console.error("[admin analytics refresh]", e);
      else toast("Analytics data could not be loaded: " + e.message, "error");
    }
    return false;
  }
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
function updatePasswordResetBadge() {
  var badge = $("password-reset-nav-badge");
  if (!badge) return;
  var count = LIVE.passwordResetRequests.length;
  badge.textContent = count;
  badge.style.display = count ? "" : "none";
  badge.setAttribute("aria-label", count + " pending password reset request" + (count === 1 ? "" : "s"));
}
function renderPasswordResetRequests() {
  updatePasswordResetBadge();
  var count = $("password-reset-panel-count"), table = $("password-reset-requests-table");
  if (!table) return;
  if (count) count.textContent = LIVE.passwordResetRequests.length;
  var html = "<thead><tr><th>Account No.</th><th>Client Name</th><th>Requested At (Asia/Manila)</th><th>Action</th></tr></thead><tbody>";
  LIVE.passwordResetRequests.forEach(function (request) {
    html += "<tr><td>" + esc(request.account_no) + "</td><td>" + esc(request.client_name) + "</td><td>" +
      esc(request.requested_at_manila) + "</td><td><button class='action' onclick='resolvePasswordResetRequest(" +
      Number(request.id) + ",this)'>Reset Password</button></td></tr>";
  });
  if (!LIVE.passwordResetRequests.length) html += "<tr><td colspan='4' class='muted' style='height:56px;text-align:center'>No pending password reset requests.</td></tr>";
  table.innerHTML = html + "</tbody>";
}
async function resolvePasswordResetRequest(id, button) {
  if (button) { button.disabled = true; button.textContent = "Resetting..."; }
  try {
    var result = await adminApi("/password-reset-requests/" + encodeURIComponent(id) + "/reset", { method: "POST" });
    LIVE.passwordResetRequests = LIVE.passwordResetRequests.filter(function (request) { return Number(request.id) !== Number(id); });
    updatePasswordResetBadge();
    renderNotices();
    ADMIN_RENDERED_SIGNATURE = adminDataSignature();
    showTemporaryClientPassword(result.temporaryPassword, result.clientName, result.accountNo);
    try {
      await syncAdminData();
      updatePasswordResetBadge();
      renderNotices();
      ADMIN_RENDERED_SIGNATURE = adminDataSignature();
    } catch (e) {
      toast("Password reset succeeded, but the request list could not be refreshed: " + e.message, "error");
    }
  } catch (e) {
    if (button && button.isConnected) { button.disabled = false; button.textContent = "Reset Password"; }
    toast(e.message || "Could not reset the client password.", "error");
  }
}
function onNoticeFilter() { pgReset("notice"); renderNotices(); }
function setNoticeTab(t) { NT.tab = t; pgReset("notice"); renderNotices(); }
function renderNotices() {
  renderPasswordResetRequests();
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
  updatePasswordResetBadge();
  var br = branchScope("");
  ["d-branch", "b-branch", "p-branch", "a-branch", "n-branch"].forEach(function (id) { fillSelect(id, "All Branches", br); });
  var curYm = new Date().toISOString().slice(0, 7);
  populateMonthFilters(true);
  ["d-month", "b-month", "a-month"].forEach(function (id) { $(id).value = curYm; });
  $("p-month").value = "";
  fillSelect("b-status", "All Status", ["Delivered", "Not Yet Sent", "Failed"]);
  fillSelect("p-method", "All Methods", ["GCash", "Cash"]);
  fillSelect("p-status", "All Statuses", ["Pending", "Verified", "Rejected"]);
  fillSelect("n-type", "All Notice Types", ["7-Day Billing Notice", "Disconnection Warning", "Payment Receipt", "System Notice"]);
  fillSelect("n-status", "All Status", ["Sent", "Not Yet Sent", "Failed"]);
  if (typeof initClientsView === "function") initClientsView();
  renderDash();
  ADMIN_RENDERED_SIGNATURE = adminDataSignature();
  setInterval(async function () {
    if (ADMIN_POLL_RUNNING || liveRefreshPaused()) return;
    ADMIN_POLL_RUNNING = true;
    try {
      await syncAdminData();
      if (liveRefreshPaused()) return;
      updatePasswordResetBadge();
      var signature = adminDataSignature();
      if (signature === ADMIN_RENDERED_SIGNATURE) return;
      populateMonthFilters(false);
      var render = {
        dash: function () { return renderDash(true); },
        billing: renderBilling,
        pay: renderPayments,
        analytics: function () { return renderAnalytics(true); },
        email: renderNotices,
        clients: renderClients
      }[ACTIVE_ADMIN_PAGE];
      var applied = render ? await renderPreservingScroll(render) : true;
      if (applied === false || liveRefreshPaused()) return;
      ADMIN_RENDERED_SIGNATURE = signature;
    } catch (e) {
      console.error("[admin live refresh]", e);
    } finally {
      ADMIN_POLL_RUNNING = false;
    }
  }, 15000);
}

if ($("d-stats") && requireRole("admin")) startAdmin();