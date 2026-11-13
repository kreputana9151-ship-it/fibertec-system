/* FiberTec - Staff portal (branch-scoped). Staff can verify payments and approve/reject cancellation requests,
   but cannot terminate or reactivate accounts (admin only). */
var STAFF_PAGES = ["dash", "clients", "pay"];
function showStaff(id) {
  showSection(STAFF_PAGES, id, "nav-");
  hideTip();
  if (id == "dash" || id == "pay") refreshPayments();
  ({ dash: renderStaff, clients: renderClients, pay: renderStaff })[id]();
}
function myClients() { return clients.filter(function (c) { return c.branch == STAFF_BRANCH; }); }
function myRequests(status) { return requests.filter(function (r) { return r.branch == STAFF_BRANCH && r.status == status; }); }
function onClientsChanged() { renderStaff(); }

function renderStaff() {
  var mine = myClients(), cnt = statusCounts(mine), pend = PAY.queue;
  var due = mine.filter(function (c) { return inBilling(c) && c.dueISO == APP_TODAY && c.balance > 0; }).length;
  $("t-verify").innerHTML = pend.length; $("t-due").innerHTML = due; $("t-grace").innerHTML = cnt["Grace Period"]; $("t-review").innerHTML = cnt["Under Review"];
  $("t-collected").innerHTML = peso(collectedThisMonth());
  /* payments to verify */
  $("dash-queue").innerHTML = !PAY.loaded ? "<p class='empty'>" + esc(PAY.error || "Loading the queue...") + "</p>" : pend.length ? headCard(pend[0]) + (pend.length > 1 ? "<p class='muted' style='margin:8px 6px 0'>+ " + (pend.length - 1) + " waiting in queue (locked until Queue #1 is done). <a style='color:#2b86ff;cursor:pointer' onclick='showStaff(\"pay\")'>Open the queue</a></p>" : "") : "<p class='empty'>No pending payments in the verification queue.</p>";
  /* clients needing attention first */
  var rank = { "Grace Period": 0, "Under Review": 1, "Active": 2, "Terminated": 3 };
  var top = mine.slice().sort(function (a, b) { return rank[a.status] - rank[b.status] || (a.balance > 0 ? 0 : 1) - (b.balance > 0 ? 0 : 1); }).slice(0, 6);
  $("dash-clients").innerHTML = top.map(function (c) { return "<div class='row-line' style='cursor:pointer' onclick='viewClient(\"" + c.no + "\")'><span>" + esc(c.name) + "<small>" + c.no + " &middot; " + c.plan + "</small></span>" + badgeFor(c.status) + "</div>"; }).join("") + "<p class='muted' style='margin:8px 6px 0'><a style='color:#2b86ff;cursor:pointer' onclick='showStaff(\"clients\")'>View all " + mine.length + " clients &rarr;</a></p>";
  /* cancellation requests */
  var rq = myRequests("Pending"), done = requests.filter(function (r) { return r.branch == STAFF_BRANCH && r.status != "Pending"; }).slice(-3).reverse();
  $("dash-requests").innerHTML = (rq.length ? rq.map(function (r) { return "<div class='q-row'><span><b>" + esc(r.name) + "</b> (" + r.acc + ")<small>Requested " + fmtD(r.date) + " &middot; " + esc(r.reason) + "</small></span><button class='btn btn-green' onclick='askRequest(\"" + r.id + "\",true)'>Approve</button><button class='btn btn-red' onclick='askRequest(\"" + r.id + "\",false)'>Reject</button></div>"; }).join("") : "<p class='empty'>No pending cancellation requests.</p>") +
    done.map(function (r) { return "<div class='row-line'><span>" + esc(r.name) + "<small>" + fmtD(r.date) + "</small></span>" + (r.status == "Approved" ? "<span class='badge orange'>Sent to Admin</span>" : "<span class='badge red'>Rejected</span>") + "</div>"; }).join("");
  $("req-count").innerHTML = rq.length;
  /* recent activity: what staff just did first, then seeded history from the branch's records */
  var dyn = S.act.filter(function (a) { return a.b == STAFF_BRANCH; }).reverse().map(function (a) { return { t: a.t, when: a.when }; });
  var seed = PAY.activity.map(function (a) { return { t: a.description, when: fmtTs(a.logged_at) }; });
  $("activity").innerHTML = dyn.concat(seed).slice(0, 9).map(function (a) { return "<div class='row-line'><span>" + esc(a.t) + "<small>" + a.when + "</small></span></div>"; }).join("") || "<p class='empty'>No activity yet...</p>";
  renderStaffPay();
}
function askRequest(id, ok) {
  var r = requests.filter(function (x) { return x.id == id; })[0];
  confirmBox(ok ? "Approve cancellation" : "Reject cancellation", ok ? "Approve the cancellation request of <b>" + esc(r.name) + "</b>? The account will move to <b>Under Review</b> for the Administrator to decide." : "Reject the cancellation request of <b>" + esc(r.name) + "</b>? The account stays active.", ok ? "Yes, approve" : "Yes, reject", function () {
    resolveCancelRequest(id, ok); toast(ok ? "Approved. Sent to Admin (Under Review)." : "Request rejected."); renderStaff(); if (!$("clients").classList.contains("hidden")) renderClients();
  }, !ok);
}

/* ---------- Payments tab (live API) ---------- */
function collectedThisMonth() {
  var n = new Date();
  return PAY.records.filter(function (r) { var d = r.verified_at && new Date(r.verified_at); return r.status == "Verified" && d && d.getFullYear() == n.getFullYear() && d.getMonth() == n.getMonth(); })
    .reduce(function (a, r) { return a + Number(r.amount); }, 0);
}
function queueItem(id) { return PAY.queue.filter(function (p) { return String(p.payment_id) == String(id); })[0]; }
function notHead(id) {
  var h = PAY.queue[0]; if (h && String(h.payment_id) == String(id)) return false;
  toast("FIFO: please process Queue #1 (the oldest submission) first.", "error"); refreshPayments(); return true;
}
function askVerify(id) {
  if (notHead(id)) return; var p = queueItem(id);
  confirmBox("Verify payment", "Please make sure the reference number matches the client's GCash receipt before you continue.<br><br><b>" + esc(p.name) + "</b> (" + p.account_no + ")<br>" + p.payment_type + " &middot; " + peso(p.amount) + "<br>Ref # <b>" + fmtRef(p.reference_no || "") + "</b><br><br>An official receipt (O.R.) will be issued automatically.<br><br>Do you want to verify this payment?", "Yes, verify", function () { doQueueAction(id, "verify"); });
}
function rejectRef(id) {
  if (notHead(id)) return; var p = queueItem(id);
  confirmBox("Reject reference number", "Are you sure you want to reject Ref # <b>" + fmtRef(p.reference_no || "") + "</b> from " + esc(p.name) + "?", "Yes, reject", function () { doQueueAction(id, "reject"); }, true);
}
function doQueueAction(id, act) {                                      // PATCH /api/staff/payments/:id/verify | reject
  if (BUSY) return; BUSY = true;
  apiCall("PATCH", "/api/staff/payments/" + id + "/" + act).then(function (d) {
    toast(act == "verify" ? "Payment verified. O.R. issued: " + d.orNo : "Payment rejected.");
  }).catch(function (e) {
    if (e && e.status == 409) toast("Out of order: " + e.message + ". The queue was refreshed.", "error");     // someone else already served Queue #1
    else if (e && e.status != 401) toast((e && e.message) || "Could not save. Please try again.", "error");
  }).then(function () { BUSY = false; refreshPayments(); });
}
function srRows() {
  var q = val("sr-search").trim().toLowerCase(), me = val("sr-method"), st = val("sr-status");
  return PAY.records.filter(function (r) { return (!me || r.method == me) && (!st || r.status == st) && (!q || ((r.account_no || "") + " " + r.name + " " + (r.reference_no || "") + " " + (r.or_no || "")).toLowerCase().indexOf(q) >= 0); });
}
function onSrFilter() { pgReset("srec"); renderStaffPay(); }
function renderStaffPay() {
  renderQueue();
  var rows = srRows(), info = paginate("srec", rows), h = "<thead><tr><th>Date</th><th>Reference No.</th><th>O.R. No.</th><th>Client</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead><tbody>";
  info.rows.forEach(function (r) { h += "<tr><td>" + fmtDate(r.created_at) + "</td><td>" + (r.reference_no ? fmtRef(r.reference_no) : "") + "</td><td>" + esc(r.or_no || "") + "</td><td>" + esc(r.name) + "</td><td>" + peso(r.amount) + "</td><td>" + r.method + "</td><td>" + badgeFor(r.status) + "</td></tr>"; });
  if (!rows.length) h += "<tr><td colspan='7' class='muted' style='height:70px;text-align:center'>No matching payments.</td></tr>";
  $("staff-records").innerHTML = h + "</tbody>"; $("sr-foot").innerHTML = footHTML("srec", info, renderStaffPay);
}
/* over-the-counter cash: finds real unpaid statements of this branch (GET /api/staff/statements/open) */
var CASH = {}, cashTimer;
function cashSearch() {
  clearTimeout(cashTimer);
  cashTimer = setTimeout(function () {
    apiCall("GET", "/api/staff/statements/open?q=" + encodeURIComponent(val("cash-search").trim())).then(function (list) {
      var box = $("cash-results"); list = list.slice(0, 6); list.forEach(function (s) { CASH[s.statement_id] = s; });
      box.innerHTML = list.length ? list.map(function (s) { return "<button type='button' onmousedown='pickCash(" + s.statement_id + ")'><b>" + esc(s.name) + "</b><small>" + s.account_no + " &middot; " + pesoPlain(s.balance) + " due</small></button>"; }).join("") : "<p class='muted' style='margin:8px 10px'>No client with a balance matches.</p>";
      box.classList.remove("hidden");
    }).catch(function (e) { if (e && e.status != 401) toast((e && e.message) || "Search failed.", "error"); });
  }, 250);
}
function pickCash(id) {
  var s = CASH[id]; $("cash-client").value = id; $("cash-results").classList.add("hidden"); $("cash-search").value = ""; $("cash-search").classList.add("hidden");
  $("cash-picked").innerHTML = "<span><b>" + esc(s.name) + "</b><small>" + s.account_no + " &middot; " + pesoPlain(s.balance) + " due</small></span><button type='button' title='Change client' onclick='clearCash()'>&times;</button>"; $("cash-picked").classList.remove("hidden");
}
function clearCash() { $("cash-client").value = ""; $("cash-picked").classList.add("hidden"); $("cash-search").classList.remove("hidden"); $("cash-search").value = ""; }
function encodeCash() {
  var id = val("cash-client"); if (!id) { toast("Search and select a client first.", "error"); return; }
  var s = CASH[id], partial = val("cash-type") == "Partial payment", amount = partial ? Math.min(Number(s.monthly_rate) / 2, Number(s.balance)) : Number(s.balance);
  apiCall("POST", "/api/staff/payments/cash", { statementId: Number(id), amount: amount }).then(function (d) {
    toast("Payment encoded. O.R. number issued: " + d.orNo); clearCash(); refreshPayments();
  }).catch(function (e) { if (e && e.status != 401) toast((e && e.message) || "Could not encode the payment.", "error"); });
}
function startStaff() {
  $("staff-who").innerHTML = "Staff - " + STAFF_BRANCH; $("staff-av").innerHTML = "S" + (branchOf(STAFF_BRANCH).code.slice(1));
  fillSelect("sr-method", "All Methods", ["GCash", "Cash"]); fillSelect("sr-status", "All Statuses", ["Verified", "Rejected"]);
  initClientsView(); renderStaff(); startPolling();
}
if ($("t-verify") && requireRole("staff")) startStaff();