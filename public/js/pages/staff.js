/* FiberTec - Staff portal (branch-scoped). Staff can verify payments and approve/reject cancellation requests,
   but cannot terminate or reactivate accounts (admin only). */
var STAFF_PAGES = ["dash", "clients", "pay"];
var STAFF_REQUESTS = [], ACTIVE_STAFF_PAGE = "dash";
function showStaff(id) { ACTIVE_STAFF_PAGE = id; showSection(STAFF_PAGES, id, "nav-"); hideTip(); ({ dash: renderStaff, clients: renderClients, pay: renderStaff })[id](); }
function myClients() { return getAllActiveClients().filter(function (c) { return c.branch == STAFF_BRANCH; }); }
function myRequests(status) { return STAFF_REQUESTS.filter(function (r) { return r.status == status; }); }
function onClientsChanged() { renderStaff(); }

function renderStaff() {
  var mine = myClients(), cnt = {
    Active: Number(PAY.statusCounts.active || 0),
    "Grace Period": Number(PAY.statusCounts.grace_period || 0),
    "Under Review": Number(PAY.statusCounts.under_review || 0),
    Terminated: Number(PAY.statusCounts.terminated || 0)
  }, pend = PAY.queue;
  var due = mine.filter(function (c) { return inBilling(c) && c.dueISO == APP_TODAY && c.balance > 0; }).length;
  $("t-verify").textContent = pend.length; $("t-due").textContent = due; $("t-active").textContent = cnt.Active;
  $("t-grace").textContent = cnt["Grace Period"]; $("t-review").textContent = cnt["Under Review"]; $("t-terminated").textContent = cnt.Terminated;
  $("t-collected").innerHTML = peso(Number(PAY.statusCounts.collected_this_month || 0));
  /* payments to verify */
  $("dash-queue").innerHTML = !PAY.loaded ? "<p class='empty'>" + esc(PAY.error || "Loading the queue...") + "</p>" : pend.length ? headCard(pend[0]) + (pend.length > 1 ? "<p class='muted' style='margin:8px 6px 0'>+ " + (pend.length - 1) + " waiting in queue (locked until Queue #1 is done). <a style='color:#2b86ff;cursor:pointer' onclick='showStaff(\"pay\")'>Open the queue</a></p>" : "") : "<p class='empty'>No pending payments in the verification queue.</p>";
  /* clients needing attention first */
  var rank = { "Grace Period": 0, "Under Review": 1, "Active": 2, "Terminated": 3 };
  var top = mine.slice().sort(function (a, b) { return rank[a.status] - rank[b.status] || (a.balance > 0 ? 0 : 1) - (b.balance > 0 ? 0 : 1); }).slice(0, 6);
  $("dash-clients").innerHTML = top.map(function (c) { return "<div class='row-line' style='cursor:pointer' onclick='viewClient(\"" + c.no + "\")'><span>" + esc(c.name) + "<small>" + c.no + " &middot; " + c.plan + "</small></span>" + badgeFor(c.status) + "</div>"; }).join("") + "<p class='muted' style='margin:8px 6px 0'><a style='color:#2b86ff;cursor:pointer' onclick='showStaff(\"clients\")'>View all " + mine.length + " clients &rarr;</a></p>";
  /* cancellation requests */
  var rq = myRequests("Pending");
  $("dash-requests").innerHTML = rq.length
    ? rq.map(function (r) { return "<div class='q-row'><span><b>" + esc(r.name) + "</b> (" + r.acc + ")<small>Requested " + fmtD(r.date) + " &middot; " + esc(r.reason) + "</small></span><button class='btn btn-green' onclick='askRequest(\"" + r.id + "\",true)'>Approve</button><button class='btn btn-red' onclick='askRequest(\"" + r.id + "\",false)'>Reject</button></div>"; }).join("")
    : "<p class='empty'>No pending cancellation requests.</p>";
  $("req-count").innerHTML = rq.length;
  /* recent activity is loaded from the branch-scoped API */
  var activity = PAY.activity.map(function (a) { return { t: a.description, when: fmtTs(a.logged_at) }; });
  $("activity").innerHTML = activity.slice(0, 9).map(function (a) { return "<div class='row-line'><span>" + esc(a.t) + "<small>" + a.when + "</small></span></div>"; }).join("") || "<p class='empty'>No activity yet...</p>";
  renderStaffPay();
}
function renderStaffLivePage() {
  if (ACTIVE_STAFF_PAGE === "clients") renderClients();
  else if (ACTIVE_STAFF_PAGE === "pay") renderStaffPay();
  else renderStaff();
}
function askRequest(id, ok) {
  var r = STAFF_REQUESTS.filter(function (x) { return String(x.id) == String(id); })[0];
  if (!r) return;
  confirmBox(ok ? "Approve cancellation" : "Reject cancellation", ok ? "Approve the cancellation request of <b>" + esc(r.name) + "</b>? The account will be terminated." : "Reject the cancellation request of <b>" + esc(r.name) + "</b>? The account stays active.", ok ? "Yes, approve" : "Yes, reject", function () {
    apiCall("PATCH", "/api/staff/cancellations/" + encodeURIComponent(id), { approve: ok }).then(function () {
      toast(ok ? "Cancellation approved. The account was terminated." : "Cancellation request rejected.");
      return refreshPayments();
    }).then(function () {
      if (!$("clients").classList.contains("hidden")) renderClients();
    }).catch(function (e) {
      if (e && e.status != 401) toast((e && e.message) || "Could not update the cancellation request.", "error");
    });
  }, !ok);
}

/* ---------- Payments tab (live API) ---------- */
function queueItem(id) { return PAY.queue.filter(function (p) { return String(p.payment_id) == String(id); })[0]; }
function notHead(id) {
  var h = PAY.queue[0]; if (h && String(h.payment_id) == String(id)) return false;
  toast("FIFO: please process Queue #1 (the oldest submission) first.", "error"); refreshPayments(); return true;
}
function paymentBreakdownHtml(total, previous, current) {
  var remainingBefore = Math.max(0, Number(total) - Number(previous));
  var excess = Math.max(0, Number(current) - remainingBefore);
  var remaining = Math.max(0, remainingBefore - Number(current));
  return "<div class='payment-breakdown-row'><span>Statement total</span><b>" + peso(total) + "</b></div>" +
    "<div class='payment-breakdown-row'><span>Previously verified</span><b>" + peso(previous) + "</b></div>" +
    "<div class='payment-breakdown-row'><span>This payment</span><b>" + peso(current) + "</b></div>" +
    (excess ? "<div class='payment-breakdown-row' style='color:#b82528'><span>OVERPAYMENT - do not verify</span><b>" + peso(excess) + "</b></div>" :
      "<div class='payment-breakdown-row'><span>Remaining after verification</span><b>" + peso(remaining) + "</b></div>");
}
function showPaymentReceipt(p, orNo) {
  modal2("<div class='dlg-head'>Payment receipt<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    "<p><b>" + esc(p.name) + "</b> (" + esc(p.account_no) + ")<br>O.R. No. <b>" + esc(orNo) + "</b></p>" +
    "<div class='payment-breakdown'>" + paymentBreakdownHtml(p.statement_total, p.verified_paid, p.amount) + "</div></div>");
}
function askVerify(id) {
  if (notHead(id)) return; var p = queueItem(id);
  if (paymentExceedsBalance(p)) {
    toast("This payment exceeds the remaining statement balance. Reject it and contact the client.", "error");
    return;
  }
  confirmBox("Verify payment", "Please make sure the reference number matches the client's GCash receipt before you continue.<br><br><b>" + esc(p.name) + "</b> (" + p.account_no + ")<br>" + p.payment_type + " &middot; " + peso(p.amount) + "<br>Ref # <b>" + fmtRef(p.reference_no || "") + "</b><br><div class='payment-breakdown'>" + paymentBreakdownHtml(p.statement_total, p.verified_paid, p.amount) + "</div><br>An official receipt (O.R.) will be issued automatically.<br><br>Do you want to verify this payment?", "Yes, verify", function () { doQueueAction(id, "verify"); });
}
function rejectRef(id) {
  if (notHead(id)) return; var p = queueItem(id);
  confirmBox("Reject reference number", "Are you sure you want to reject Ref # <b>" + fmtRef(p.reference_no || "") + "</b> from " + esc(p.name) + "?", "Yes, reject", function () { doQueueAction(id, "reject"); }, true);
}
function doQueueAction(id, act) {                                      // PATCH /api/staff/payments/:id/verify | reject
  if (BUSY) return;
  var p = queueItem(id);
  if (act == "verify" && paymentExceedsBalance(p)) {
    toast("This payment exceeds the remaining statement balance. Reject it and contact the client.", "error");
    return;
  }
  BUSY = true;
  apiCall("PATCH", "/api/staff/payments/" + id + "/" + act).then(function (d) {
    toast(act == "verify" ? "Payment verified. O.R. issued: " + d.orNo : "Payment rejected.");
    if (act == "verify" && p) showPaymentReceipt(p, d.orNo);
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
  updateCashPreview();
}
function clearCash() { $("cash-client").value = ""; $("cash-picked").classList.add("hidden"); $("cash-search").classList.remove("hidden"); $("cash-search").value = ""; updateCashPreview(); }
function cashFigures() {
  var s = CASH[val("cash-client")]; if (!s) return null;
  var total = Number(s.amount || 0), previous = Number(s.amount_paid || 0), remaining = Math.max(0, total - previous);
  var partialOption = $("cash-type").options[1];
  var terminated = String(s.client_status || "").toLowerCase() == "terminated";
  var partialAlreadyPaid = (terminated || previous > 0 || String(s.payment_status || "").toLowerCase() == "partially paid" || String(s.stored_payment_status || "").toLowerCase() == "partially paid") && remaining > 0;
  partialOption.disabled = partialAlreadyPaid; partialOption.hidden = partialAlreadyPaid;
  if (partialAlreadyPaid && val("cash-type") == "Partial payment") $("cash-type").value = "Full payment";
  $("cash-type").options[0].textContent = partialAlreadyPaid ? "Full Payment (Remaining Balance)" : "Full payment";
  var partial = val("cash-type") == "Partial payment", amount = partial ? Math.min(Number(s.monthly_rate) / 2, remaining) : remaining;
  return { statement_total: total, verified_paid: previous, amount: amount };
}
function updateCashPreview() {
  var box = $("cash-preview"), f = cashFigures();
  if (!box) return;
  if (!f) { box.innerHTML = ""; box.classList.add("hidden"); return; }
  box.innerHTML = "<b class='payment-breakdown-title'>Receipt preview</b>" + paymentBreakdownHtml(f.statement_total, f.verified_paid, f.amount);
  box.classList.remove("hidden");
}
function encodeCash() {
  var id = val("cash-client"); if (!id) { toast("Search and select a client first.", "error"); return; }
  var s = CASH[id], figures = cashFigures();
  if (!figures || !(figures.amount > 0)) { toast("The selected statement has no remaining balance.", "error"); return; }
  apiCall("POST", "/api/staff/payments/cash", { statementId: Number(id), amount: figures.amount }).then(function (d) {
    toast("Payment encoded. O.R. number issued: " + d.orNo);
    showPaymentReceipt({ name: s.name, account_no: s.account_no, statement_total: figures.statement_total, verified_paid: figures.verified_paid, amount: figures.amount }, d.orNo);
    clearCash(); refreshPayments();
  }).catch(function (e) { if (e && e.status != 401) toast((e && e.message) || "Could not encode the payment.", "error"); });
}
function startStaff() {
  $("staff-who").innerHTML = "Staff - " + STAFF_BRANCH; $("staff-av").innerHTML = "S" + (branchOf(STAFF_BRANCH).code.slice(1));
  fillSelect("sr-method", "All Methods", ["GCash", "Cash"]); fillSelect("sr-status", "All Statuses", ["Verified", "Rejected"]);
  document.addEventListener("input", function (e) { if (e.target && e.target.id == "cash-type") updateCashPreview(); });
  document.addEventListener("change", function (e) { if (e.target && e.target.id == "cash-type") updateCashPreview(); });
  initClientsView(); renderStaff(); startPolling();
}
if ($("t-verify") && requireRole("staff")) startStaff();