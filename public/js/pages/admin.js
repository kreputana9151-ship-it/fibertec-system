/* FiberTec - Admin portal pages (Dashboard, Billing, Payments, Analytics, Email & Portal) */
var ADMIN_PAGES = ["dash", "clients", "billing", "pay", "analytics", "email"];
var STATUS_COLORS = ["#4cb153", "#fde400", "#fdad00", "#ff5454"], C_BILLED = "#3167bd", C_COLL = "#2daea6";
var BILL = { sel: null }, NT = { tab: "All" };
function showAdmin(id) { showSection(ADMIN_PAGES, id, "a-"); hideTip(); ({ dash: renderDash, clients: renderClients, billing: renderBilling, pay: renderPayments, analytics: renderAnalytics, email: renderNotices })[id](); }
function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
function branchScope(id) { var b = val(id); return b ? [b] : branchNames(); }

/* ---------- PDF Statement Export ---------- */
function downloadStatementPDF(accountNo, monthKey) {
  var c = clientByNo(accountNo);
  if (!c) { toast("Client record not found."); return; }
  var m = monthKey || val("b-month") || "2026-10";
  var s = statement(c, m);
  var end = addDays(s.due, 30);
  var w = window.open("", "_blank", "width=820,height=920");
  if (!w) { toast("Please allow pop-ups to download the PDF statement."); return; }
  var payRows = s.recs.filter(function (r) { return r.status != "Rejected"; }).map(function (r) {
    return "<tr><td>" + fmtD(r.date, 1) + "</td><td>" + esc(r.method) + "</td><td>" + esc(r.ref ? fmtRef(r.ref) : "-") + "</td><td>" + esc(r.or || "-") + "</td><td style='text-align:right'>" + peso(r.amount) + "</td></tr>";
  }).join("") || "<tr><td colspan='5' style='color:#777;font-style:italic'>No payments recorded for this statement.</td></tr>";

  w.document.write(
    "<!DOCTYPE html><html><head><title>" + esc(s.inv) + " - FiberTec Statement</title>" +
    "<style>body{font-family:Arial,sans-serif;color:#1b2a4a;padding:36px;max-width:740px;margin:auto}" +
    ".top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #013f70;padding-bottom:14px}" +
    ".top h1{margin:0;color:#013f70;font-size:22px}.tag{font-size:12px;letter-spacing:1.5px;color:#5197d7;font-weight:bold}" +
    ".grid{display:flex;justify-content:space-between;margin:20px 0;font-size:13px;line-height:1.6}" +
    ".sum{display:flex;gap:24px;background:#f4f7fb;padding:12px 16px;border-radius:8px;margin-bottom:20px}" +
    ".sum div{flex:1}.sum small{display:block;color:#666;font-size:11px;text-transform:uppercase}.sum b{font-size:15px;color:#013f70}" +
    "table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px}" +
    "th{text-align:left;background:#013f70;color:#fff;padding:8px 10px;font-size:11px;letter-spacing:.5px}" +
    "td{padding:8px 10px;border-bottom:1px solid #e2e8f0}" +
    ".tot{display:flex;justify-content:space-between;font-size:16px;font-weight:bold;border-top:2px solid #013f70;padding-top:10px;color:#013f70}" +
    "@media print{body{padding:12px}}</style></head><body>" +
    "<div class='top'><div><h1>FiberTec IT Solutions</h1><div class='tag'>E - STATEMENT</div></div>" +
    "<div style='text-align:right'><strong style='font-size:16px'>" + esc(s.inv) + "</strong><br><small>Issued " + fmtD(s.bill) + "</small></div></div>" +
    "<div class='sum'><div><small>Payment Status</small><b>" + esc(s.pay) + "</b></div><div><small>Due Date</small><b>" + fmtD(s.due, 1) + "</b></div><div><small>Total Amount Due</small><b>" + peso(s.balance) + "</b></div></div>" +
    "<div class='grid'><div><strong>BILL TO</strong><br><b>" + esc(c.name.toUpperCase()) + "</b><br>" + esc(c.address) + "<br>" + esc(c.email) + "</div>" +
    "<div style='text-align:right'><strong>ACCOUNT DETAILS</strong><br>" + esc(acctLabel(c)) + " (" + esc(c.no) + ")<br>" + esc(c.branch.toUpperCase()) + " BRANCH<br>Status: " + esc(c.status) + "</div></div>" +
    "<table><thead><tr><th>DESCRIPTION</th><th>BILLING PERIOD</th><th style='text-align:right'>AMOUNT</th></tr></thead><tbody>" +
    "<tr><td>" + esc(c.plan.toUpperCase()) + "</td><td>" + fmtD(s.due, 1) + " - " + fmtD(end, 1) + ", " + m.slice(0, 4) + "</td><td style='text-align:right'>" + peso(s.amount) + "</td></tr></tbody></table>" +
    "<table><thead><tr><th>DATE</th><th>METHOD</th><th>REF NO.</th><th>O.R. NO.</th><th style='text-align:right'>PAID</th></tr></thead><tbody>" + payRows + "</tbody></table>" +
    "<div class='tot'><span>Total Amount Due</span><span>" + peso(s.balance) + "</span></div>" +
    "<script>window.onload=function(){window.print();};</script></body></html>"
  );
  w.document.close();
}

/* ---------- Dashboard ---------- */
function renderDash() {
  var b = val("d-branch"), m = val("d-month") || "2026-10", cl = clients.filter(function (c) { return !b || c.branch == b; }), cnt = statusCounts(cl);
  var stm = statementsFor(m, b), billed = 0; stm.forEach(function (s) { billed += s.amount; });
  var pays = paymentsFor(m, b), coll = sumVerified(pays), out = Math.max(0, billed - coll);
  $("d-stats").innerHTML =
    '<div class="stat" style="background:#00417c"><b>Total Clients</b><span>' + cl.length + '</span><small>' + cnt.Active + ' active + ' + cnt["Grace Period"] + ' grace + ' + cnt["Under Review"] + ' review + ' + cnt.Terminated + ' terminated</small></div>' +
    '<div class="stat" style="background:#5197d7"><b>Total Billed amount</b><span>' + peso(billed) + '</span><small>' + stm.length + ' statements</small></div>' +
    '<div class="stat" style="background:#3167bd"><b>Total Collections Verified</b><span>' + peso(coll) + '</span><small>' + pct(coll, billed) + '% of billed</small></div>' +
    '<div class="stat" style="background:#2daea6"><b>Total Outstanding Receivables</b><span>' + peso(out) + '</span><small>' + pct(out, billed) + '% of billed</small></div>';
  /* branch performance: one row per branch, columns add up to the totals */
  var rows = "", tc = 0, ta = 0, tb = 0, tcol = 0;
  branchScope("d-branch").forEach(function (bn) {
    var bc = clients.filter(function (c) { return c.branch == bn; }), bs = statementsFor(m, bn), bb = 0; bs.forEach(function (s) { bb += s.amount; });
    var cc = sumVerified(paymentsFor(m, bn)), p = pct(cc, bb), act = statusCounts(bc).Active; tc += bc.length; ta += act; tb += bb; tcol += cc;
    rows += "<tr><td>" + bn + "</td><td><div class='track' title='" + p + "% collected'><i style='width:0' data-w='" + Math.min(100, p) + "%'></i></div></td><td>" + bc.length + "</td><td>" + act + "</td><td>" + p + "%</td></tr>";
  });
  $("branch-bars").innerHTML = "<table class='bp'><thead><tr><th>Branch</th><th>Billing Cycle Progress</th><th>Clients</th><th>Active</th><th>Collected</th></tr></thead><tbody>" + rows + "</tbody><tfoot><tr><td>Total</td><td></td><td>" + tc + "</td><td>" + ta + "</td><td>" + pct(tcol, tb) + "%</td></tr></tfoot></table>"; growIn($("branch-bars"));
  var vals = STATUSES.map(function (s) { return cnt[s]; }), lg = "";
  STATUSES.forEach(function (s, i) { lg += "<p><i style='background:" + STATUS_COLORS[i] + "'></i>" + s + "<span>" + vals[i] + "</span></p>"; });
  setDonut("status-donut", vals, STATUS_COLORS); $("donut-n").innerHTML = cl.length + "<small>clients</small>";
  $("status-legend").innerHTML = lg + "<p class='total'>Total<span>" + cl.length + "</span></p>";
  /* collection overview: one group per branch, hover shows that branch's exact values */
  var names = branchScope("d-branch"), bl = [], co = [];
  names.forEach(function (bn) { var t = 0; statementsFor(m, bn).forEach(function (s) { t += s.amount; }); bl.push(t); co.push(sumVerified(paymentsFor(m, bn))); });
  barChart({ id: "dash-chart", labels: names, h: 210, fmt: pesoPlainK, sub: monthLabel(m), series: [{ name: "Billed", color: C_BILLED, vals: bl, exact: function (v) { return pesoPlain(v); } }, { name: "Collected", color: C_COLL, vals: co, exact: function (v) { return pesoPlain(v); } }], extra: function (i) { return "Collection rate: <b>" + pct(co[i], bl[i]) + "%</b> &middot; Outstanding: " + pesoPlain(Math.max(0, bl[i] - co[i])); } });
  var rp = pays.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a._i || 0) < (b._i || 0) ? 1 : -1; }).slice(0, 12), h = "<thead><tr><th>Date</th><th>Client Name</th><th>Amount</th><th>Status</th></tr></thead><tbody>";
  rp.forEach(function (r) { h += "<tr><td>" + fmtD(r.date) + "</td><td>" + esc(r.name) + "</td><td>" + peso(r.amount) + "</td><td>" + badgeFor(r.status) + "</td></tr>"; });
  $("recent-pay").innerHTML = h + (rp.length ? "" : "<tr><td colspan='4' class='muted'>No payments for this selection.</td></tr>") + "</tbody>";
}
function pesoPlainK(v) { return v >= 1000 ? "\u20B1" + (v / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "K" : "\u20B1" + v; }

/* ---------- Billing ---------- */
function billRows() {
  var m = val("b-month") || "2026-10", b = val("b-branch"), st = val("b-status"), q = val("b-search").trim().toLowerCase();
  var all = statementsFor(m, b);
  return { all: all, rows: all.filter(function (s) { return (!st || s.send == st) && (!q || (s.c.no + " " + s.c.name + " " + s.inv).toLowerCase().indexOf(q) >= 0); }) };
}
function onBillFilter() { pgReset("billing"); renderBilling(); }
function renderBilling() {
  var m = val("b-month") || "2026-10", r = billRows(), cnt = { Delivered: 0, "Not Yet Sent": 0, Failed: 0 }; r.all.forEach(function (s) { cnt[s.send]++; });
  $("b-stats").innerHTML = '<div class="stat" style="background:#3167bd"><b>Total Statements</b><span>' + r.all.length + '</span></div><div class="stat" style="background:#81c715"><b>Delivered</b><span>' + cnt.Delivered + '</span></div><div class="stat" style="background:#10c3b8"><b>Not Yet Sent</b><span>' + cnt["Not Yet Sent"] + '</span></div><div class="stat" style="background:#d74548"><b>Failed</b><span>' + cnt.Failed + '</span></div>';
  $("bill-title").innerHTML = "BILLING FOR " + monthLabel(m).toUpperCase() + " <span class='muted'>(one row per Active / Grace Period client)</span>";
  var info = paginate("billing", r.rows), h = "<thead><tr><th>Invoice No.</th><th class='col-x'>Account No.</th><th>Client Name</th><th class='col-x'>Branch</th><th>Billing Date</th><th>Due Date</th><th>Amount Due</th><th>Status</th></tr></thead><tbody>";
  info.rows.forEach(function (s) { h += "<tr class='click " + (BILL.sel == s.c.no ? "sel" : "") + "' onclick='toggleBill(\"" + s.c.no + "\")'><td>" + s.inv + "</td><td class='col-x'>" + s.c.no + "</td><td>" + esc(s.c.name) + "</td><td class='col-x'>" + s.c.branch + "</td><td>" + fmtD(s.bill) + "</td><td>" + fmtD(s.due) + "</td><td>" + peso(s.amount) + "</td><td>" + badgeFor(s.send) + "</td></tr>"; });
  if (!r.rows.length) h += emptyRow(8);
  $("billing-table").innerHTML = h + "</tbody>"; $("bill-foot").innerHTML = footHTML("billing", info, renderBilling);
  renderBillPanel();
}
function toggleBill(no) { BILL.sel = BILL.sel == no ? null : no; renderBilling(); }
function closeBill() { BILL.sel = null; renderBilling(); }
function renderBillPanel() {
  var p = $("bill-panel"), c = BILL.sel && clientByNo(BILL.sel), m = val("b-month") || "2026-10";
  $("bill-split").classList.toggle("open", !!c); if (!c) { p.innerHTML = ""; return; }
  var s = statement(c, m), hist = "";
  MONTHS.forEach(function (x) { if (!hasStatement(c, x.k)) return; var h = statement(c, x.k); hist += "<tr class='" + (x.k == m ? "cur" : "") + "'><td>" + monShort(x.k) + "</td><td>" + h.inv + "</td><td>" + peso(h.amount) + "</td><td>" + peso(h.paid) + "</td><td>" + badgeFor(h.pay) + "</td><td>" + badgeFor(h.send) + "</td></tr>"; });
  var payRows = s.recs.length ? s.recs.map(function (r) { return "<tr><td>" + fmtD(r.date, 1) + "</td><td>" + r.method + "</td><td>" + (r.ref ? fmtRef(r.ref) : "") + "</td><td>" + esc(r.or || "") + "</td><td>" + peso(r.amount) + "</td><td>" + badgeFor(r.status) + "</td></tr>"; }).join("") : "<tr><td colspan='6' style='color:#888;font-style:italic'>No payments recorded for this statement yet.</td></tr>";
  var canSend = m == "2026-10" && s.send != "Delivered";
  p.innerHTML = "<div class='bpn-head'><div><h3>" + esc(c.name) + "<span>" + c.no + "</span></h3><p>" + monShort(m) + " &middot; " + c.short + " &middot; Due " + fmtD(s.due) + "</p><div class='tags'>" + badgeFor(s.pay) + badgeFor(s.send) + "</div></div><button class='x' title='Close' onclick='closeBill()'>&times;</button></div>" +
    "<div class='bpn-body'><div class='bpn-meta'><div><small>Invoice no.</small><b>" + s.inv + "</b></div><div><small>Billing date</small><b>" + fmtD(s.bill) + "</b></div><div><small>Due date</small><b>" + fmtD(s.due) + "</b></div><div><small>Branch</small><b>" + c.branch + "</b></div><div><small>Plan</small><b>" + c.plan + "</b></div><div><small>Account status</small><b>" + c.status + "</b></div></div>" +
    "<div class='stmt'><div class='top'><div><h4>FiberTec IT Solutions</h4><div class='tag'>E - STATEMENT</div></div><div style='text-align:right'><b style='font-size:16px'>" + s.inv + "</b><br><span class='muted'>Issued " + fmtD(s.bill) + "</span></div></div><hr>" +
    "<div class='h'><span>BILL TO</span></div><div class='acc'><div><b style='color:#000'>" + esc(c.name.toUpperCase()) + "</b><br>" + esc(c.address) + "</div><div><span class='h' style='display:block'>ACCOUNT</span>" + acctLabel(c) + "<br><span class='muted'>" + c.branch.toUpperCase() + " BRANCH</span><br><span class='muted'>" + esc(c.email) + "</span></div></div><hr class='l'>" +
    "<div class='h'><span>DESCRIPTION</span><span>AMOUNT</span></div><div class='ln'><span>" + c.plan.toUpperCase() + "<small>" + fmtD(s.due, 1).toUpperCase() + " - " + fmtD(addDays(s.due, 30), 1).toUpperCase() + ", " + m.slice(0, 4) + "</small></span><span>" + peso(s.amount) + "</span></div><hr class='l'>" +
    "<div class='h'><span>PAID</span><span style='color:#000;font-size:13.5px;font-weight:500;letter-spacing:0'>" + peso(s.paid) + "</span></div><hr style='margin-top:10px'><div class='tot'><span>Total amount due</span><span>" + peso(s.balance) + "</span></div></div>" +
    "<div class='bpn-h'>Payments for this statement</div><table class='bpn-tbl'><thead><tr><th>Date</th><th>Method</th><th>Ref No.</th><th>O.R. No.</th><th>Amount</th><th>Status</th></tr></thead><tbody>" + payRows + "</tbody></table>" +
    "<div class='bpn-h'>Billing history</div><table class='bpn-tbl'><thead><tr><th>Period</th><th>Invoice</th><th>Amount</th><th>Paid</th><th>Payment Status</th><th>Status</th></tr></thead><tbody>" + hist + "</tbody></table>" +
    "<div class='bpn-actions'>" + (canSend ? "<button class='btn btn-blue' onclick='sendStatement(\"" + c.no + "\")'>" + (s.send == "Failed" ? "Resend statement" : "Send statement now") + "</button>" : "") + "<button class='btn btn-light' onclick='downloadStatementPDF(\"" + c.no + "\",\"" + m + "\")'>Download PDF</button><button class='btn btn-light' onclick='viewClient(\"" + c.no + "\")'>View client</button></div></div>";
}
function sendStatement(no) { setClient(no, { bill: "Delivered" }); toast("Statement delivered to " + clientByNo(no).name + "."); renderBilling(); }

/* ---------- Payments ---------- */
function payRows() {
  var m = val("p-month"), b = val("p-branch"), me = val("p-method"), st = val("p-status"), q = val("p-search").trim().toLowerCase();
  var base = paymentsFor(m, b).filter(function (r) { return !q || (r.acc + " " + r.name + " " + r.ref + " " + r.or).toLowerCase().indexOf(q) >= 0; });
  return { base: base, rows: base.filter(function (r) { return (!me || r.method == me) && (!st || r.status == st); }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b._o - a._o; }) };
}
function onPayFilter() { pgReset("pay"); renderPayments(); }
function renderPayments() {
  var r = payRows(), ver = r.base.filter(function (x) { return x.status == "Verified"; }), pend = r.base.filter(function (x) { return x.status == "Pending"; });
  $("p-stats").innerHTML = '<div class="stat" style="background:#3167bd"><b>Total Collections Verified</b><span>' + peso(sumVerified(r.base)) + '</span></div><div class="stat" style="background:#5197d7"><b>Verified Payments</b><span>' + ver.length + '</span></div><div class="stat" style="background:#2daea6"><b>Pending Verification</b><span>' + pend.length + '</span></div>';
  var info = paginate("pay", r.rows), h = "<thead><tr><th>Date</th><th>Reference No.</th><th>O.R. No.</th><th>Account No.</th><th>Client Name</th><th>Branch</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead><tbody>";
  info.rows.forEach(function (x) { h += "<tr><td>" + fmtD(x.date) + "</td><td>" + (x.ref ? fmtRef(x.ref) : "") + "</td><td>" + esc(x.or || "") + "</td><td>" + x.acc + "</td><td>" + esc(x.name) + "</td><td>" + x.branch + "</td><td>" + peso(x.amount) + "</td><td>" + x.method + "</td><td>" + badgeFor(x.status) + "</td></tr>"; });
  if (!r.rows.length) h += emptyRow(9);
  $("pay-table").innerHTML = h + "</tbody>"; $("pay-foot").innerHTML = footHTML("pay", info, renderPayments);
}

/* ---------- Branch analytics ---------- */
function renderAnalytics() {
  var b = val("a-branch"), m = val("a-month") || "2026-10", names = branchScope("a-branch"), cl = clients.filter(function (c) { return !b || c.branch == b; });
  var stm = statementsFor(m, b), billed = 0, deliv = 0; stm.forEach(function (s) { billed += s.amount; if (s.send == "Delivered") deliv++; });
  var coll = sumVerified(paymentsFor(m, b));
  $("an-stats").innerHTML = '<div class="stat" style="background:#013f70"><b>Total Revenue (recorded payments)</b><span>' + peso(coll) + '</span></div><div class="stat" style="background:#5197d7"><b>Collection Rate</b><span>' + pct(coll, billed) + '%</span><small>' + peso(coll) + ' of ' + peso(billed) + '</small></div><div class="stat" style="background:#2daea6"><b>Billing Completion Rate</b><span>' + pct(deliv, stm.length) + '%</span><small>' + deliv + ' of ' + stm.length + ' statements delivered</small></div>';
  var bl = [], co = []; names.forEach(function (bn) { var t = 0; statementsFor(m, bn).forEach(function (s) { t += s.amount; }); bl.push(t); co.push(sumVerified(paymentsFor(m, bn))); });
  barChart({ id: "an-chart", labels: names, h: 230, fmt: pesoPlainK, sub: monthLabel(m), series: [{ name: "Billed", color: C_BILLED, vals: bl, exact: pesoPlain }, { name: "Collected", color: C_COLL, vals: co, exact: pesoPlain }], extra: function (i) { return "Collection rate: <b>" + pct(co[i], bl[i]) + "%</b>"; } });
  var cols = ["#1b7a8a", "#0d4f7a", "#f5a623", "#8fb8d0"], pv = PLANS.map(function (p) { return cl.filter(function (c) { return c.plan == p.n; }).length; }), lg = "";
  PLANS.forEach(function (p, i) { lg += "<p><i style='background:" + cols[i] + "'></i>" + p.n + "<span>" + pv[i] + " (" + pct(pv[i], cl.length) + "%)</span></p>"; });
  setDonut("plan-donut", pv, cols); $("plan-n").innerHTML = cl.length + "<small>clients</small>"; $("plan-legend").innerHTML = lg + "<p class='total'>Total<span>" + cl.length + "</span></p>";
  var reg = [], churn = [], from = addDays(m + "-01", -150);
  names.forEach(function (bn) { var bc = clients.filter(function (c) { return c.branch == bn; }); reg.push(bc.filter(function (c) { return c.installed >= from && c.installed <= m + "-31"; }).length); churn.push(pct(bc.filter(function (c) { return c.status == "Terminated"; }).length, bc.length)); });
  barChart({ id: "reg-chart", labels: names, h: 160, fmt: function (v) { return Math.round(v * 10) / 10; }, sub: "Registered in the last 6 months", series: [{ name: "New clients", color: C_BILLED, vals: reg }] });
  barChart({ id: "churn-chart", labels: names, h: 160, fmt: function (v) { return Math.round(v * 10) / 10 + "%"; }, sub: "Terminated accounts / all clients", series: [{ name: "Cancellation rate", color: "#d74548", vals: churn, exact: function (v) { return v + "%"; } }] });
  anova(); markov();
}
function anova() {
  var g = {}, all = 0, n = 0, k = 0; clients.forEach(function (c) { (g[c.branch] = g[c.branch] || []).push(c.rate); });
  var names = Object.keys(g); k = names.length; names.forEach(function (nm) { g[nm].forEach(function (v) { all += v; n++; }); });
  var gm = all / n, ssb = 0, ssw = 0; names.forEach(function (nm) { var a = g[nm], mean = a.reduce(function (x, y) { return x + y; }, 0) / a.length; ssb += a.length * Math.pow(mean - gm, 2); a.forEach(function (v) { ssw += Math.pow(v - mean, 2); }); });
  var F = (ssb / (k - 1)) / (ssw / (n - k));
  $("anova").innerHTML = "<table class='mini'><thead><tr><th>Source</th><th>df</th><th>SS</th></tr></thead><tbody><tr><td>Between branches</td><td>" + (k - 1) + "</td><td>" + Math.round(ssb).toLocaleString() + "</td></tr><tr><td>Within branches</td><td>" + (n - k) + "</td><td>" + Math.round(ssw).toLocaleString() + "</td></tr></tbody></table><p><b>F = " + F.toFixed(2) + "</b></p><p class='note-s'>Computed in the browser from the " + n + " dummy clients' monthly rates.</p>";
}
function markov() {
  var s = ["Active", "Grace", "Review", "Terminated"], P = [[.94, .05, 0, .01], [.6, .2, .15, .05], [.3, 0, .3, .4], [.1, 0, 0, .9]];
  var t = "<table class='mini'><thead><tr><th>From \\ To</th>" + s.map(function (x) { return "<th>" + x + "</th>"; }).join("") + "</tr></thead><tbody>";
  for (var i = 0; i < 4; i++) t += "<tr><td>" + s[i] + "</td>" + P[i].map(function (x) { return "<td>" + x.toFixed(2) + "</td>"; }).join("") + "</tr>";
  var two = 0; for (var k = 0; k < 4; k++) two += P[0][k] * P[k][3];
  $("markov").innerHTML = t + "</tbody></table><p><b>P(Active &rarr; Terminated in 2 months) = " + (two * 100).toFixed(1) + "%</b></p><p class='note-s'>Sample transition matrix (illustrative).</p>";
}

/* ---------- Email & portal notifications ---------- */
function noticeRows(skipTab) {
  var q = val("n-search").trim().toLowerCase(), b = val("n-branch"), ty = val("n-type"), st = val("n-status");
  return buildNotices().filter(function (n) {
    if (!skipTab && NT.tab == "Emails" && n.channel != "Email") return false; if (!skipTab && NT.tab == "Portal Notifications" && n.channel != "Portal Notification") return false;
    return (!b || n.branch == b) && (!ty || n.type == ty) && (!st || n.status == st) && (!q || (n.acc + " " + n.name).toLowerCase().indexOf(q) >= 0);
  });
}
function onNoticeFilter() { pgReset("notice"); renderNotices(); }
function setNoticeTab(t) { NT.tab = t; pgReset("notice"); renderNotices(); }
function renderNotices() {
  var all = buildNotices(), base = noticeRows(true), rows = noticeRows(false), em = 0, po = 0, fl = 0;
  all.forEach(function (n) { if (n.channel == "Email" && n.status == "Sent") em++; if (n.channel == "Portal Notification") po++; if (n.status == "Failed") fl++; });
  $("n-stats").innerHTML = '<div class="stat" style="background:#00417c"><b>Total Notifications</b><span>' + all.length + '</span></div><div class="stat" style="background:#5197d7"><b>Emails Sent</b><span>' + em + '</span></div><div class="stat" style="background:#3167bd"><b>Portal Notifications</b><span>' + po + '</span></div><div class="stat" style="background:#d74548"><b>Failed Deliveries</b><span>' + fl + '</span></div>';
  var t = ""; ["All", "Emails", "Portal Notifications"].forEach(function (tb) { var n = base.filter(function (x) { return tb == "All" || (tb == "Emails" ? x.channel == "Email" : x.channel == "Portal Notification"); }).length; t += "<button class='" + (tb == NT.tab ? "active" : "") + "' onclick='setNoticeTab(\"" + tb + "\")'>" + tb + "<em>" + n + "</em></button>"; });
  $("notif-tabs").innerHTML = t;
  var info = paginate("notice", rows), h = "<thead><tr><th>Date Sent</th><th>Account No.</th><th>Client Name</th><th>Channel</th><th>Recipient / Destination</th><th>Notice Type</th><th>Status</th><th>Action</th></tr></thead><tbody>";
  info.rows.forEach(function (n) { h += "<tr><td>" + fmtD(n.date) + "</td><td>" + n.acc + "</td><td>" + esc(n.name) + "</td><td><b>" + n.channel + "</b></td><td>" + esc(n.recipient) + "</td><td>" + n.type + "</td><td>" + badgeFor(n.status) + "</td><td>" + (n.status == "Failed" ? "<button class='action' onclick='resendNotice(\"" + n.id + "\")'>Resend</button>" : "") + "</td></tr>"; });
  if (!rows.length) h += emptyRow(8);
  $("email-table").innerHTML = h + "</tbody>"; $("notice-foot").innerHTML = footHTML("notice", info, renderNotices);
}
function resendNotice(id) { S.nres[id] = "Sent"; saveState(); toast("Notice resent."); renderNotices(); }

/* ---------- Expand Card Overlay ---------- */
function expandCard(btn) {
  var card = btn.closest(".dcard");
  if (!card) return;

  var clonedCard = card.cloneNode(true);
  var expBtn = clonedCard.querySelector(".expand-btn");
  if (expBtn) {
    expBtn.outerHTML = '<button class="x" style="margin-left:auto; cursor:pointer; font-size:28px; border:0; background:none; color:#002f6e; font-weight:bold;" onclick="closeModal()">&times;</button>';
  }

  // Open modal
  var modal = modal2(clonedCard.outerHTML, "");
  
  // Stretch modal container across the screen content area
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

  // Ensure inner card stretches to 100% full bounds
  var innerCard = modal.querySelector(".dcard");
  if (innerCard) {
    innerCard.style.width = "100%";
    innerCard.style.height = "100%";
    innerCard.style.border = "0";
    innerCard.style.padding = "0";
    innerCard.style.boxShadow = "none";
    innerCard.style.display = "flex";
    innerCard.style.flexDirection = "column";
    innerCard.style.flex = "1";
  }

  // Calculate dynamic bar chart height based on screen size
  var availableH = Math.max(300, window.innerHeight - 240);

  var chPlot = modal.querySelector(".ch-plot");
  if (chPlot) {
    chPlot.style.setProperty("--ch", availableH + "px");
    chPlot.style.height = availableH + "px";
  }
  var chY = modal.querySelector(".ch-y");
  if (chY) {
    chY.style.setProperty("--ch", availableH + "px");
    chY.style.height = availableH + "px";
  }
  var ch = modal.querySelector(".ch");
  if (ch) {
    ch.style.setProperty("--ch", availableH + "px");
  }

  // Expand Donut chart if opening donut widget
  var donut = modal.querySelector(".donut");
  if (donut) {
    donut.style.width = "320px";
    donut.style.height = "320px";
    donut.style.margin = "20px auto";
  }

  // Expand mini data tables
  var miniTbl = modal.querySelector(".mini");
  if (miniTbl) {
    miniTbl.style.fontSize = "16px";
    miniTbl.querySelectorAll("th, td").forEach(function(td) {
      td.style.height = "50px";
      td.style.padding = "10px 20px";
    });
  }

  growIn(modal);
}

/* ---------- start ---------- */
function startAdmin() {
  var br = branchNames();
  ["d-branch", "b-branch", "p-branch", "a-branch", "n-branch"].forEach(function (id) { fillSelect(id, "All Branches", br); });
  ["d-month", "b-month", "a-month"].forEach(function (id) { fillSelect(id, "", monthItems()); });
  fillSelect("p-month", "All Months", monthItems());
  fillSelect("b-status", "All Status", ["Delivered", "Not Yet Sent", "Failed"]); fillSelect("p-method", "All Methods", ["GCash", "Cash"]); fillSelect("p-status", "All Statuses", ["Pending", "Verified", "Rejected"]);
  fillSelect("n-type", "All Notice Types", ["7-Day Billing Notice", "Disconnection Warning", "Payment Receipt", "System Notice"]); fillSelect("n-status", "All Status", ["Sent", "Not Yet Sent", "Failed"]);
  initClientsView(); renderDash();
}
if ($("d-stats") && requireRole("admin")) startAdmin();