/* FiberTec - Client portal (everything is derived from the shared dummy data) */
var ME = null, CPAGES = ["home", "payment", "statement", "notifications"], selM = "2026-10";
function stmtMonths() { return MONTHS.filter(function (m) { return hasStatement(ME, m.k); }); }
function cur() { return statement(ME, "2026-10"); }
function cycleLabel(s) {
  if (s.balance == 0) return "Paid"; if (ME.hasPending) return "Awaiting verification"; if (s.paid > 0) return "Partially paid";
  var d = dayDiff(s.due, APP_TODAY); return d == 0 ? "Due today" : d > 0 ? "Due in " + d + " day" + (d == 1 ? "" : "s") : "Overdue";
}
function pillClass(l) { return l == "Paid" ? "paid" : (l == "Awaiting verification" || l == "Partially paid") ? "wait" : (l == "Overdue" || l == "Rejected") ? "rej" : ""; }
function pill(l, id) { return "<span class='c-pill " + pillClass(l) + "'" + (id ? " id='" + id + "'" : "") + ">" + l + "</span>"; }
function canPayNow() { return inBilling(ME) && cur().balance > 0 && !ME.hasPending; }

function myHistory() {
  return records.filter(function (r) { return r.acc == ME.no; }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }).map(function (r) {
    return { method: r.method, type: r.type, ref: r.ref ? fmtRef(r.ref) : "", or: r.or || "", date: "Submitted " + fmtD(r.date, 1), amount: r.amount, status: r.status == "Verified" ? "Paid" : r.status == "Pending" ? "Awaiting verification" : "Rejected" };
  });
}
function histRows(list) {
  return list.map(function (e) { return "<div class='c-row'>" + e.method + " &middot; " + e.type + (e.ref ? " <span class='m'>&middot; client reference &middot;</span> " + esc(e.ref) : "") + (e.or ? " <span class='m'>&middot; official receipt &middot;</span> " + esc(e.or) : "") + "<span class='amt'>" + peso(e.amount) + "</span><span class='sd'>" + e.date + "</span><span class='st'>" + pill(e.status) + "</span></div>"; }).join("") || "<p class='muted'>No payments yet.</p>";
}
function showPage(id) {
  CPAGES.forEach(function (p) { $(p).classList.add("hidden"); var n = $("nav-" + p); if (n) n.classList.remove("on"); });
  $(id).classList.remove("hidden"); var on = $("nav-" + id); if (on) on.classList.add("on"); $("bell").classList.add("hidden"); window.scrollTo(0, 0); renderClient();
}
function toggleBell() { $("bell").classList.toggle("hidden"); }

/* cancellation banner + button state */
function cancelState() {
  var r = myCancelRequest(ME.no);
  if (ME.status == "Terminated") return { banner: "<div class='c-banner red'><b>Your account has been terminated.</b> Please contact your branch if you want to be reconnected.</div>", can: false };
  if (ME.status == "Under Review" && ME.reason == "Client Cancellation Request") return { banner: "<div class='c-banner blue'><b>Cancellation approved by branch staff.</b> Your request is now under review by the Administrator. We will notify you once it is final.</div>", can: false };
  if (r && r.status == "Pending") return { banner: "<div class='c-banner amber'><b>Cancellation request sent</b> on " + fmtD(r.date) + ". Branch staff are reviewing it.</div>", can: false, pending: true };
  if (r && r.status == "Rejected") return { banner: "<div class='c-banner blue'><b>Your cancellation request was declined</b> by branch staff. Your connection stays active. You may submit a new request.</div>", can: true };
  if (ME.status == "Grace Period") return { banner: "<div class='c-banner amber'><b>Your account is in the grace period.</b> Please settle your balance by " + fmtD(ME.graceEnd) + " to avoid disconnection.</div>", can: true };
  if (ME.status == "Under Review") return { banner: "<div class='c-banner amber'><b>Your account is under review</b> because of unpaid balance.</div>", can: false };
  return { banner: "", can: true };
}
function cancelBtn(ghostOnly) { var st = cancelState(); return st.can || st.pending ? "<button class='c-btn ghost' " + (st.pending ? "disabled" : "") + " onclick='requestCancel()'>" + (st.pending ? "Cancellation pending" : "Request cancellation") + "</button>" : ""; }

function renderClient() {
  var s = cur(), label = inBilling(ME) ? cycleLabel(s) : ME.status, nextDue = iso(new Date(2026, 10, ME.due)), st = cancelState();
  $("c-banner").innerHTML = st.banner; $("c-name").innerHTML = esc(ME.name.toUpperCase()); $("c-av").innerHTML = initials(ME.name);
  var mbps = (ME.plan.match(/\d+(?=\s*Mbps)/) || ["0"])[0], pn = ME.plan.replace(/\s*\d+\s*Mbps/, "").trim();
  $("c-cards").innerHTML = "<div class='c-card'><p class='c-lab'>SUBSCRIPTION</p><p class='c-big'>" + mbps + " Mbps</p><p class='c-sub'><b>" + pn + " " + mbps + "</b> &middot; <b>" + peso(ME.rate) + "/month</b></p></div>" +
    "<div class='c-card'><p class='c-lab'>CURRENT BALANCE</p><p class='c-big'>" + peso(s.balance) + "</p>" + pill(label) + "</div>" +
    "<div class='c-card'><p class='c-lab'>DUE DATE</p><p class='c-big' style='font-size:32px;margin-top:16px'>" + fmtD(s.due) + "</p><p class='c-sub'>balance " + peso(s.balance) + "</p></div>" +
    "<div class='c-card'><p class='c-lab'>DAYS LEFT IN CYCLE</p><p class='c-big'>" + dayDiff(nextDue, APP_TODAY) + "</p><p class='c-sub'>Next statement " + fmtD(nextDue) + ". Billing date stays on the " + ordinal(ME.due) + " even if you change plan</p></div>";
  $("c-acct").innerHTML = "<h3>Your Account</h3><div class='c-kv'><b>Account no.</b><span>" + acctLabel(ME) + " &nbsp;<span class='muted'>(" + ME.no + ")</span></span></div><div class='c-kv'><b>Address</b><span>" + esc(ME.address) + "</span></div><div class='c-kv'><b>Branch</b><span>" + ME.branch + "</span></div><div class='c-kv'><b>Installed</b><span>" + fmtD(ME.installed) + "</span></div><div class='c-kv'><b>Device location</b><span>" + esc(ME.device) + "</span></div><div class='c-kv'><b>Email</b><span>" + esc(ME.email) + "</span></div>" +
    "<div class='c-btns'><button class='c-btn' onclick='showPage(\"payment\")'>Pay now</button><button class='c-btn' onclick='showPage(\"statement\")'>View statements</button>" + cancelBtn() + "</div>";
  var h = myHistory(); $("recent").innerHTML = histRows(h.slice(0, 4)); $("history").innerHTML = histRows(h);
  $("p-acct").innerHTML = s.inv; var pp = $("p-pill"); pp.className = "c-pill " + pillClass(label); pp.textContent = label;
  $("p-due").innerHTML = "Due " + fmtD(s.due) + " &nbsp; Paid " + peso(s.paid) + " of " + peso(ME.rate); $("p-branch").innerHTML = ME.branch;
  $("paytype").style.display = canPayNow() ? "" : "none"; if (!canPayNow()) $("steps23").classList.add("hidden");
  $("p-blocked").innerHTML = !inBilling(ME) ? "Payments are not available while your account is " + ME.status.toLowerCase() + "." : ME.hasPending ? "Your payment is waiting for staff verification." : s.balance == 0 ? "You are fully paid for this statement. Thank you!" : "";
  renderStatements(); renderNotifications();
}
function updatePay() {
  var t = val("paytype"), s = cur(); $("steps23").classList.toggle("hidden", t == ""); $("partialnote").classList.toggle("hidden", t != "partial");
  $("payamt").innerHTML = peso(t == "partial" ? Math.min(ME.rate / 2, s.balance) : s.balance);
}
function cancelPay() { $("ref").value = ""; $("referr").innerHTML = ""; $("paytype").value = ""; updatePay(); }
function submitPayment() {
  var ref = val("ref").replace(/\s/g, ""), t = val("paytype"), s = cur();
  if (!/^[0-9]{13}$/.test(ref)) { $("referr").innerHTML = "Reference number must be exactly 13 digits."; return; }
  addRecord({ acc: ME.no, name: ME.name, branch: ME.branch, amount: t == "partial" ? Math.min(ME.rate / 2, s.balance) : s.balance, method: "GCash", ref: ref, status: "Pending", type: t == "partial" ? "Partial payment" : "Full payment" });
  logActivity(ME.branch, "New GCash payment from " + ME.name + " (Ref " + fmtRef(ref) + ") waiting for verification.");
  cancelPay(); renderClient(); toast("Payment submitted. Branch staff will verify it shortly.");
}

/* ---------- Statements ---------- */
function stmtStatus(s) { return s.m == "2026-10" ? (inBilling(ME) ? cycleLabel(s) : ME.status) : (s.balance == 0 ? "Paid" : "Unpaid"); }
function selectStmt(m) { selM = m; renderStatements(); }
function renderStatements() {
  var ms = stmtMonths(); if (!ms.length) { $("stmt-table").innerHTML = "<tbody><tr><td class='muted'>No statements yet.</td></tr></tbody>"; $("estmt").innerHTML = ""; return; }
  if (!ms.some(function (m) { return m.k == selM; })) selM = ms[0].k;
  var t = "<thead><tr><th>STATEMENT</th><th>DUE</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>";
  ms.forEach(function (m) { var s = statement(ME, m.k); t += "<tr class='" + (m.k == selM ? "sel" : "") + "' onclick='selectStmt(\"" + m.k + "\")'><td><b>" + s.inv + "</b><small>" + ME.plan.replace(/\s*\d+\s*Mbps/, "") + " " + ((ME.plan.match(/\d+(?=\s*Mbps)/) || [""])[0]) + "</small></td><td>" + fmtD(s.due) + "</td><td>" + peso(s.amount) + "</td><td>" + pill(stmtStatus(s)) + "</td></tr>"; });
  $("stmt-table").innerHTML = t + "</tbody>";
  var s = statement(ME, selM), lbl = stmtStatus(s), recs = s.recs.filter(function (r) { return r.status != "Rejected"; });
  var pays = recs.map(function (r) { return "<div class='est-ln'><span>" + r.method + " &middot; " + (r.ref ? "Ref " + fmtRef(r.ref) : "") + (r.ref && r.or ? " &middot; " : "") + (r.or ? "O.R. " + esc(r.or) : "") + "<small>" + fmtD(r.date) + " &middot; " + (r.status == "Verified" ? "Verified" : "Awaiting verification") + "</small></span><span>" + peso(r.amount) + "</span></div>"; }).join("") || "<div class='est-ln'><span style='opacity:.5'>No payments yet</span><span></span></div>";
  var end = addDays(s.due, 30);
  $("estmt").innerHTML = "<div class='est-head'><div><h3>FiberTec IT Solutions</h3><small>E - STATEMENT</small></div><div class='r'><b>" + s.inv + "</b><small>Issued " + fmtD(s.bill) + "</small></div></div><div class='est-body'>" +
    "<div class='est-sum'><div><small>Status</small><b>" + lbl + "</b></div><div><small>Due date</small><b>" + fmtD(s.due, 1) + "</b></div><div><small>Amount due</small><b>" + peso(s.balance) + "</b></div></div>" +
    "<div class='est-h'><span>BILL TO</span><span>ACCOUNT</span></div><hr><div class='est-ln' style='align-items:flex-start'><span style='max-width:62%'><b>" + esc(ME.name.toUpperCase()) + "</b><small>" + esc(ME.address) + "</small></span><span style='text-align:right'>" + acctLabel(ME) + "<small>" + ME.branch.toUpperCase() + " BRANCH</small></span></div>" +
    "<div class='est-h'><span>DESCRIPTION</span><span>AMOUNT</span></div><hr><div class='est-ln'><span>" + ME.plan.toUpperCase() + "<small>" + fmtD(s.due, 1).toUpperCase() + " - " + fmtD(end, 1).toUpperCase() + ", " + end.slice(0, 4) + "</small></span><span>" + peso(s.amount) + "</span></div>" +
    "<div class='est-h'><span>PAYMENTS RECEIVED</span><span>" + peso(s.paid) + "</span></div><hr class='l'>" + pays + "<hr>" +
    "<div class='est-ln est-tot'><span>Total amount due</span><span>" + peso(s.balance) + "</span></div>" +
    "<div class='est-acts'>" + (selM == "2026-10" && canPayNow() ? "<button class='c-btn' onclick='showPage(\"payment\")'>Pay now</button>" : "") + "<button class='c-btn' style='background:#fff;color:#013f70;border:1px solid #013f70' onclick='toast(\"Statement " + s.inv + " downloaded (demo)\")'>Download PDF</button>" + (selM == "2026-10" ? cancelBtn() : "") + "</div></div>";
}

/* ---------- Cancellation request ---------- */
function requestCancel() {
  modal2("<div class='dlg-head'>Request cancellation<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'><p>Are you sure you want to cancel your FiberTec connection? This sends a request for account <b>" + acctLabel(ME) + "</b> to your branch staff.</p>" +
    "<label>Reason</label><select id='cx-reason'><option>Moving to a new address</option><option>Switching provider</option><option>Financial reasons</option><option>No longer needs internet</option><option>Other</option></select>" +
    "<label>Enter your password to confirm</label><input type='password' id='cx-pw' autocomplete='current-password'><p class='error' id='cx-err'></p>" +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>No, keep my connection</button><button class='btn btn-red' onclick='confirmCancel()'>Yes, cancel my connection</button></div></div>", "sm");
}
function confirmCancel() {
  var pw = val("cx-pw"); if (!pw || pw != sessionStorage.getItem("fiberPw")) { $("cx-err").innerHTML = "Incorrect password. Cancellation was not submitted."; return; }
  submitCancelRequest(ME, val("cx-reason")); logActivity(ME.branch, "Cancellation request received from " + ME.name + " (" + ME.no + ")."); closeModal(); renderClient(); toast("Cancellation request sent to your branch staff.");
}

/* ---------- Notifications ---------- */
var NOTIFS = [];
function renderNotifications() {
  NOTIFS = []; var first = ME.name.split(" ")[0], ages = ["3 Hours ago", "1 month 7 hours ago", "2 months 1 day ago", "3 months 1 day ago"];
  stmtMonths().forEach(function (m, i) { var s = statement(ME, m.k); NOTIFS.push(["e-Statement ready: " + pesoPlain(s.amount) + " due " + fmtD(s.due), ages[i] || "4 months ago", "Hi " + first + ",\n\nyour e-Statement " + s.inv + " is ready. Amount due: " + pesoPlain(s.amount) + ".\n\nDue date: " + fmtD(s.due) + "." + (i == 0 ? "\n\nOn the due date you can pay in full, or pay half (" + pesoPlain(s.amount / 2) + ") and choose a promise date for the other half. Pay with GCash to 0900 000 0000 and submit your reference number in the portal, or pay in cash at the " + ME.branch + " branch." : "")]); });
  records.filter(function (r) { return r.acc == ME.no && r.month == "2026-10" && r.status == "Verified"; }).forEach(function (r) { NOTIFS.splice(1, 0, ["Payment received: " + pesoPlain(r.amount), "Today", "Hi " + first + ",\n\nwe received your " + r.method + " payment of " + pesoPlain(r.amount) + " (" + (r.ref ? "Ref " + fmtRef(r.ref) + ", " : "") + "O.R. " + r.or + "). Thank you!"]); });
  NOTIFS.splice(1, 0, ["New sign in to your FiberTec account", "6 hours 29 mins ago", "Hi " + first + ",\n\nwe noticed a new sign in to your FiberTec account. If this was you, no action is needed."]);
  var dd = ""; NOTIFS.slice(0, 5).forEach(function (n, i) { dd += "<div class='c-dd-item' onclick='openNotif(" + i + ")'>" + esc(n[0]) + "<small>" + n[1] + "</small><a>View full notification</a></div>"; });
  $("dd-list").innerHTML = dd; if (!window._ni) window._ni = 0; drawNotif(window._ni);
}
function drawNotif(i) {
  window._ni = i; var l = ""; NOTIFS.forEach(function (n, k) { l += "<div class='c-nitem " + (k == i ? "sel" : "") + "' onclick='drawNotif(" + k + ")'><img src='images/edit_icon.png' alt=''><div>" + esc(n[0]) + "<small>" + n[1] + "</small></div></div>"; });
  $("n-list").innerHTML = l; $("n-view").innerHTML = "<div class='nh'><img src='images/edit_icon.png' alt=''><div><h2>" + esc(NOTIFS[i][0]) + "</h2><small>" + NOTIFS[i][1] + "</small></div></div><div class='nb'>" + esc(NOTIFS[i][2]) + "</div>";
}
function openNotif(i) { drawNotif(i); showPage("notifications"); }

if ($("c-cards") && requireRole("client")) {
  ME = clientByNo(sessionStorage.getItem("fiberAcc"));
  if (!ME) logout(); else { $("c-welcome").innerHTML = "WELCOME " + esc(ME.name.toUpperCase()); showPage("home"); }
}
