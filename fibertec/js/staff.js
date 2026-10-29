/* FiberTec - Staff portal (branch-scoped). Staff can verify payments and approve/reject cancellation requests,
   but cannot terminate or reactivate accounts (admin only). */
var STAFF_PAGES = ["dash", "clients", "pay"];
function showStaff(id) { showSection(STAFF_PAGES, id, "nav-"); hideTip(); ({ dash: renderStaff, clients: renderClients, pay: renderStaff })[id](); }
function myClients() { return clients.filter(function (c) { return c.branch == STAFF_BRANCH; }); }
function myPending() { return records.filter(function (r) { return r.branch == STAFF_BRANCH && r.status == "Pending"; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; }); }
function myRequests(status) { return requests.filter(function (r) { return r.branch == STAFF_BRANCH && r.status == status; }); }
function onClientsChanged() { renderStaff(); }

function queueRow(p, short) {
  return "<div class='q-row'><span><b>" + esc(p.name) + "</b> (" + p.acc + ")<small>" + fmtD(p.date) + " &middot; " + p.type + " &middot; Ref " + fmtRef(p.ref) + " &middot; " + peso(p.amount) + "</small></span>" +
    "<button class='btn btn-green' onclick='askVerify(\"" + p.id + "\")'>Verify</button><button class='btn btn-red' onclick='rejectRef(\"" + p.id + "\")'>Invalid Ref #</button></div>";
}
function renderStaff() {
  var mine = myClients(), cnt = statusCounts(mine), pend = myPending(), mc = 0;
  var due = mine.filter(function (c) { return inBilling(c) && c.dueISO == APP_TODAY && c.balance > 0; }).length;
  $("t-verify").innerHTML = pend.length; $("t-due").innerHTML = due; $("t-grace").innerHTML = cnt["Grace Period"]; $("t-review").innerHTML = cnt["Under Review"];
  $("t-collected").innerHTML = peso(sumVerified(paymentsFor("2026-10", STAFF_BRANCH)));
  /* payments to verify */
  var q = pend.slice(0, 5).map(function (p) { return queueRow(p); }).join("");
  $("dash-queue").innerHTML = (q || "<p class='empty'>Nothing here to verify.</p>") + (pend.length > 5 ? "<p class='muted' style='margin:8px 6px 0'>+ " + (pend.length - 5) + " more in <a style='color:#2b86ff;cursor:pointer' onclick='showStaff(\"pay\")'>Payments</a></p>" : "");
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
  var seed = records.filter(function (r) { return r.branch == STAFF_BRANCH && r.month == "2026-10" && r.status == "Verified"; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 8).map(function (r) { return { t: r.method == "Cash" ? "Cash payment encoded for " + r.name + ". O.R. " + r.or + " issued." : "Verified " + r.name + " (Ref " + fmtRef(r.ref) + "). O.R. " + r.or + " issued. Heads-up sent to Admin.", when: fmtD(r.date) }; });
  $("activity").innerHTML = dyn.concat(seed).slice(0, 9).map(function (a) { return "<div class='row-line'><span>" + esc(a.t) + "<small>" + a.when + "</small></span></div>"; }).join("") || "<p class='empty'>No activity yet...</p>";
  renderStaffPay();
}
function askRequest(id, ok) {
  var r = requests.filter(function (x) { return x.id == id; })[0];
  confirmBox(ok ? "Approve cancellation" : "Reject cancellation", ok ? "Approve the cancellation request of <b>" + esc(r.name) + "</b>? The account will move to <b>Under Review</b> for the Administrator to decide." : "Reject the cancellation request of <b>" + esc(r.name) + "</b>? The account stays active.", ok ? "Yes, approve" : "Yes, reject", function () {
    resolveCancelRequest(id, ok); toast(ok ? "Approved. Sent to Admin (Under Review)." : "Request rejected."); renderStaff(); if (!$("clients").classList.contains("hidden")) renderClients();
  }, !ok);
}

/* ---------- Payments tab ---------- */
function askVerify(id) {
  var p = records.filter(function (r) { return r.id == id; })[0];
  confirmBox("Verify payment", "Please make sure the reference number matches the client's GCash receipt before you continue.<br><br><b>" + esc(p.name) + "</b> (" + p.acc + ")<br>" + p.type + " &middot; " + peso(p.amount) + "<br>Ref # <b>" + fmtRef(p.ref) + "</b><br><br>An official receipt (O.R.) will be issued automatically.<br><br>Do you want to verify this payment?", "Yes, verify", function () { verifyRef(id); });
}
function verifyRef(id) {
  var p = records.filter(function (r) { return r.id == id; })[0]; setRecordStatus(id, "Verified"); p = records.filter(function (r) { return r.id == id; })[0];
  logActivity(STAFF_BRANCH, "Verified " + p.name + " (Ref " + fmtRef(p.ref) + "). O.R. " + p.or + " issued. Heads-up sent to Admin."); toast("Payment verified. O.R. issued: " + p.or); renderStaff();
}
function rejectRef(id) {
  var p = records.filter(function (r) { return r.id == id; })[0];
  confirmBox("Reject reference number", "Are you sure you want to reject Ref # <b>" + fmtRef(p.ref) + "</b> from " + esc(p.name) + "?", "Yes, reject", function () { setRecordStatus(id, "Rejected"); logActivity(STAFF_BRANCH, "Rejected Ref " + fmtRef(p.ref) + " from " + p.name + "."); renderStaff(); }, true);
}
function srRows() {
  var q = val("sr-search").trim().toLowerCase(), me = val("sr-method"), st = val("sr-status");
  return records.filter(function (r) { return r.branch == STAFF_BRANCH && r.status != "Pending" && (!me || r.method == me) && (!st || r.status == st) && (!q || (r.acc + " " + r.name + " " + r.ref + " " + r.or).toLowerCase().indexOf(q) >= 0); }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b._o - a._o; });
}
function onSrFilter() { pgReset("srec"); renderStaffPay(); }
function renderStaffPay() {
  var pend = myPending(); $("pcount").innerHTML = pend.length;
  $("queue").innerHTML = pend.length ? pend.map(function (p) { return queueRow(p); }).join("") : "<p class='empty'>Nothing here to verify.</p>";
  var rows = srRows(), info = paginate("srec", rows), h = "<thead><tr><th>Date</th><th>Reference No.</th><th>O.R. No.</th><th>Client</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead><tbody>";
  info.rows.forEach(function (r) { h += "<tr><td>" + fmtD(r.date, 1) + "</td><td>" + (r.ref ? fmtRef(r.ref) : "") + "</td><td>" + esc(r.or || "") + "</td><td>" + esc(r.name) + "</td><td>" + peso(r.amount) + "</td><td>" + r.method + "</td><td>" + badgeFor(r.status) + "</td></tr>"; });
  if (!rows.length) h += "<tr><td colspan='7' class='muted' style='height:70px;text-align:center'>No matching payments.</td></tr>";
  $("staff-records").innerHTML = h + "</tbody>"; $("sr-foot").innerHTML = footHTML("srec", info, renderStaffPay);
  var sel = val("cash-client"); if (sel && clientByNo(sel).balance <= 0) clearCash(); else if (sel) pickCash(sel);
}
function cashOwing() { return myClients().filter(function (c) { return inBilling(c) && c.balance > 0; }); }
function cashSearch() {
  var q = val("cash-search").trim().toLowerCase(), box = $("cash-results"), list = cashOwing().filter(function (c) { return !q || (c.no + " " + c.name).toLowerCase().indexOf(q) >= 0; }).slice(0, 6);
  box.innerHTML = list.length ? list.map(function (c) { return "<button type='button' onmousedown='pickCash(\"" + c.no + "\")'><b>" + esc(c.name) + "</b><small>" + c.no + " &middot; " + pesoPlain(c.balance) + " due</small></button>"; }).join("") : "<p class='muted' style='margin:8px 10px'>No client with a balance matches.</p>";
  box.classList.remove("hidden");
}
function pickCash(no) {
  var c = clientByNo(no); $("cash-client").value = no; $("cash-results").classList.add("hidden"); $("cash-search").value = ""; $("cash-search").classList.add("hidden");
  $("cash-picked").innerHTML = "<span><b>" + esc(c.name) + "</b><small>" + c.no + " &middot; " + pesoPlain(c.balance) + " due</small></span><button type='button' title='Change client' onclick='clearCash()'>&times;</button>"; $("cash-picked").classList.remove("hidden");
}
function clearCash() { $("cash-client").value = ""; $("cash-picked").classList.add("hidden"); $("cash-search").classList.remove("hidden"); $("cash-search").value = ""; }
function encodeCash() {
  var no = val("cash-client"); if (!no) { toast("Search and select a client first.", "error"); return; }
  var c = clientByNo(no), partial = val("cash-type") == "Partial payment", amount = partial ? Math.min(c.rate / 2, c.balance) : c.balance, or = "OR-" + (10000 + Math.floor(Math.random() * 89999));
  addRecord({ acc: c.no, name: c.name, branch: c.branch, amount: amount, method: "Cash", ref: "", or: or, status: "Verified", type: partial ? "Partial payment" : "Full payment" });
  logActivity(STAFF_BRANCH, "Cash payment encoded for " + c.name + ". O.R. " + or + " issued."); toast("Payment encoded. O.R. number issued: " + or); clearCash(); renderStaff();
}
function startStaff() {
  $("staff-who").innerHTML = "Staff - " + STAFF_BRANCH; $("staff-av").innerHTML = "S" + (branchOf(STAFF_BRANCH).code.slice(1));
  fillSelect("sr-method", "All Methods", ["GCash", "Cash"]); fillSelect("sr-status", "All Statuses", ["Verified", "Rejected"]);
  initClientsView(); renderStaff();
}
if ($("t-verify") && requireRole("staff")) startStaff();
