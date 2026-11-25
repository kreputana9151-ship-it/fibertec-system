/* FiberTec - Client portal. Everything is read from / saved to the REAL database through /api/client/... */
var ME = null, STM = [], STMT_MONTHS = [], STMT_FILTER = "", PAYS = [], NOTES = [], NOTIFS = [], CPAGES = ["home", "payment", "statement", "notifications"], selId = null, BUSYP = false, SEL_N = null, PREV_UNREAD = null, CLIENT_RENDERED_SIGNATURE = "";
function todayISO() { return manilaISO(); }
function inBillingNow() { return ME.status == "Active" || ME.status == "Grace Period"; }
function verifiedPaid(s) {
  return Number(s.paid || 0);
}
function remainingBalance(s) { return Math.max(0, Number(s.amount || 0) - verifiedPaid(s)); }
function cur() {
  var s = STM[0] || { id: 0, inv: "-", bill: todayISO(), due: todayISO(), amount: 0, paid: 0, balance: 0 };
  s.paid = verifiedPaid(s); s.balance = Math.max(0, Number(s.amount || 0) - s.paid);
  return s;
}
function mapStmt(s) { return { id: s.statement_id, inv: s.invoice_no, month: String(s.billing_month || "").slice(0, 7), bill: s.issued_date, due: s.due_date, amount: Number(s.amount), paid: Number(s.amount_paid), balance: Number(s.balance), pay: s.payment_status, partialLocked: Number(s.amount_paid) > 0 || String(s.stored_payment_status || s.payment_status || "").toLowerCase() == "partially paid" }; }
function cycleLabel(s) {
  if (!STM.length) return "No statement yet"; if (s.balance == 0) return "Paid"; if (ME.hasPending) return "Awaiting verification"; if (s.paid > 0) return "Partially paid";
  var d = dayDiff(s.due, todayISO()); return d == 0 ? "Due today" : d > 0 ? "Due in " + d + " day" + (d == 1 ? "" : "s") : "Overdue";
}
function pillClass(l) { return l == "Paid" ? "paid" : (l == "Awaiting verification" || l == "Partially paid") ? "wait" : (l == "Overdue" || l == "Rejected") ? "rej" : ""; }
function pill(l, id) { return "<span class='c-pill " + pillClass(l) + "'" + (id ? " id='" + id + "'" : "") + ">" + l + "</span>"; }
function canPayNow() {
  return STM.length > 0 && cur().balance > 0 && !ME.hasPending;
}
function nextDueISO() { return STM.length ? cur().due : todayISO(); }

function myHistory() {
  return PAYS.map(function (r) { return { method: r.method, type: r.payment_type, ref: r.reference_no ? fmtRef(r.reference_no) : "", or: r.or_no || "", date: "Submitted " + fmtD(r.payment_date, 1), amount: r.amount, status: r.status == "Verified" ? "Paid" : r.status == "Pending" ? "Awaiting verification" : "Rejected" }; });
}
function histRows(list) {
  return list.map(function (e) { return "<div class='c-row'>" + e.method + " &middot; " + e.type + (e.ref ? " <span class='m'>&middot; client reference &middot;</span> " + esc(e.ref) : "") + (e.or ? " <span class='m'>&middot; official receipt &middot;</span> " + esc(e.or) : "") + "<span class='amt'>" + peso(e.amount) + "</span><span class='sd'>" + e.date + "</span><span class='st'>" + pill(e.status) + "</span></div>";   }).join("") || "<p class='muted'>No payments found.</p>";
}
function showPage(id) {
  CPAGES.forEach(function (p) { $(p).classList.add("hidden"); var n = $("nav-" + p); if (n) n.classList.remove("on"); });
  $(id).classList.remove("hidden"); var on = $("nav-" + id); if (on) on.classList.add("on"); $("bell").classList.add("hidden"); window.scrollTo(0, 0); renderClient();
}
function toggleBell() { $("bell").classList.toggle("hidden"); }

/* cancellation banner + button state */
function cancelState() {
  var r = ME.cancel;
  if (ME.status == "Terminated") return { banner: "<div class='c-banner red'><b>Your account has been terminated.</b> Please contact your branch if you want to be reconnected.</div>", can: false };
  if (ME.status == "Under Review" && ME.reason == "Client Cancellation Request") return { banner: "<div class='c-banner blue'><b>Cancellation approved by branch staff.</b> Your request is now under review by the Administrator. We will notify you once it is final.</div>", can: false };
  if (r && r.status == "Pending") return { banner: "<div class='c-banner amber'><b>Cancellation request sent</b> on " + fmtD(r.request_date) + ". Branch staff are reviewing it.</div>", can: false, pending: true };
  if (r && r.status == "Rejected") return { banner: "<div class='c-banner blue'><b>Your cancellation request was declined</b> by branch staff. Your connection stays active. You may submit a new request.</div>", can: true };
  if (ME.status == "Grace Period") return { banner: "<div class='c-banner amber'><b>Your account is in the grace period.</b> Please settle your balance by " + (ME.graceEnd ? fmtD(ME.graceEnd) : "the grace end date") + " to avoid disconnection.</div>", can: true };
  if (ME.status == "Under Review") return { banner: "<div class='c-banner amber'><b>Your account is under review</b> because of unpaid balance.</div>", can: false };
  return { banner: "", can: true };
}
function cancelBtn() { var st = cancelState(); return st.can || st.pending ? "<button class='c-btn ghost' " + (st.pending ? "disabled" : "") + " onclick='requestCancel()'>" + (st.pending ? "Cancellation pending" : "Request cancellation") + "</button>" : ""; }

function renderClient() {
  if (!ME) return;
  var s = cur(), label = inBillingNow() ? cycleLabel(s) : ME.status, nextDue = nextDueISO(), st = cancelState();
  $("c-banner").innerHTML = st.banner; $("c-name").innerHTML = esc(ME.name.toUpperCase()); $("c-av").innerHTML = initials(ME.name); $("c-welcome").innerHTML = "WELCOME " + esc(ME.name.toUpperCase());
  var mbps = (ME.plan.match(/\d+(?=\s*Mbps)/) || ["0"])[0], pn = ME.plan.replace(/\s*\d+\s*Mbps/, "").trim();
  $("c-cards").innerHTML = "<div class='c-card'><p class='c-lab'>SUBSCRIPTION</p><p class='c-big'>" + mbps + " Mbps</p><p class='c-sub'><b>" + esc(pn) + " " + mbps + "</b> &middot; <b>" + peso(ME.rate) + "/month</b></p></div>" +
    "<div class='c-card'><p class='c-lab'>CURRENT BALANCE</p><p class='c-big'>" + peso(ME.totalBalance) + "</p>" + pill(label) + "</div>" +
    "<div class='c-card'><p class='c-lab'>DUE DATE</p><p class='c-big' style='font-size:32px;margin-top:16px'>" + fmtD(s.due) + "</p><p class='c-sub'>balance " + peso(s.balance) + "</p></div>" +
    "<div class='c-card'><p class='c-lab'>DAYS LEFT IN CYCLE</p><p class='c-big'>" + dayDiff(nextDue, todayISO()) + "</p><p class='c-sub'>Next statement " + fmtD(nextDue) + ". Billing follows your anniversary date</p></div>";
  $("c-acct").innerHTML = "<h3>Your Account</h3><div class='c-kv'><b>Account no.</b><span>" + ME.no + "</span></div><div class='c-kv'><b>Address</b><span>" + esc(ME.address) + "</span></div><div class='c-kv'><b>Branch</b><span>" + esc(ME.branch) + "</span></div><div class='c-kv'><b>Installed</b><span>" + fmtD(ME.installed) + "</span></div><div class='c-kv'><b>Device location</b><span>" + esc(ME.device) + "</span></div><div class='c-kv'><b>Email</b><span>" + esc(ME.email) + "</span></div>" +
    "<div class='c-btns'><button class='c-btn' onclick='showPage(\"payment\")'>Pay now</button><button class='c-btn' onclick='showPage(\"statement\")'>View statements</button>" + cancelBtn() + "</div>";
  var h = myHistory(); $("recent").innerHTML = histRows(h.slice(0, 4)); $("history").innerHTML = histRows(h);
  $("p-acct").innerHTML = esc(s.inv); var pp = $("p-pill"); pp.className = "c-pill " + pillClass(label); pp.textContent = label;
  $("p-due").innerHTML = "Due " + fmtD(s.due) + " &nbsp; Paid " + peso(s.paid) + " of " + peso(s.amount); $("p-branch").innerHTML = esc(ME.branch);
  $("paytype").style.display = canPayNow() ? "" : "none";
  updatePaymentOptions(s);
  $("p-blocked").innerHTML = !STM.length || s.balance <= 0
    ? "No pending balance to pay."
    : ME.hasPending
      ? "Your payment is waiting for staff verification."
      : "";
  renderStatements(); renderNotifications(); updatePay();
  CLIENT_RENDERED_SIGNATURE = clientDataSignature();
}
function updatePaymentOptions(s) {
  var select = $("paytype"), full = select.querySelector("option[value='full']"), partial = select.querySelector("option[value='partial']");
  var terminated = String(ME.status || "").toLowerCase() == "terminated";
  var partialAlreadyPaid = (terminated || s.paid > 0 || s.partialLocked) && s.balance > 0;
  partial.disabled = partialAlreadyPaid; partial.hidden = partialAlreadyPaid;
  full.textContent = partialAlreadyPaid ? "Full Payment (Remaining Balance)" : "Full payment";
  if (partialAlreadyPaid && select.value == "partial") select.value = "full";
}
function payAmount() {
  var s = cur(), remaining = remainingBalance(s);
  return val("paytype") == "partial" && String(ME.status || "").toLowerCase() != "terminated"
    ? Math.min(Number(ME.rate) / 2, remaining)
    : remaining;
}
function updatePay() {
  if (!ME) return;
  var t = val("paytype"), s = cur(), enabled = canPayNow(), amount;
  updatePaymentOptions(s);
  t = val("paytype"); amount = t && enabled ? payAmount() : 0;
  $("steps23").classList.toggle("hidden", !t || !enabled); $("partialnote").classList.toggle("hidden", t != "partial");
  $("payamt").innerHTML = peso(amount); $("pay-total").innerHTML = peso(s.amount);
  $("pay-previous").innerHTML = peso(s.paid); $("pay-current").innerHTML = peso(amount);
  $("pay-remaining").innerHTML = peso(Math.max(0, Number(s.amount) - s.paid - amount));
  $("partialnote").textContent = s.paid > 0 && s.balance > 0
    ? "A partial payment has already been verified. Please pay the full remaining balance."
    : "After staff verify your half. Once your account is in the grace period, the full amount is required.";
}
function cancelPay() { $("ref").value = ""; $("referr").innerHTML = ""; $("paytype").value = ""; updatePay(); }
function submitPayment() {                                             // goes to the staff Payments Verification Queue
  var ref = val("ref"), t = val("paytype"), s = cur();
  if (!t) return;
  if (/\s/.test(ref)) { $("referr").innerHTML = "Reference number must not contain whitespace."; return; }
  if (!/^[0-9]{13}$/.test(ref)) { $("referr").innerHTML = "Reference number must be exactly 13 digits."; return; }
  if (BUSYP) return; BUSYP = true; $("referr").innerHTML = "";
  return apiCall("POST", "/api/client/payments", { statementId: s.id, amount: payAmount(), referenceNo: ref })
    .then(function () { cancelPay(); toast("Payment submitted. Branch staff will verify it shortly."); return loadAll(); })
    .catch(function (e) { if (e && e.status != 401) $("referr").innerHTML = esc((e && e.message) || "Could not submit your payment. Please try again."); })
    .then(function () { BUSYP = false; renderClient(); });
}
document.addEventListener("input", function (e) { if (e.target && e.target.id == "paytype") updatePay(); });
document.addEventListener("change", function (e) { if (e.target && e.target.id == "paytype") updatePay(); });

/* ---------- Statements ---------- */
function stmtStatus(s) { return s.id == cur().id ? (inBillingNow() ? cycleLabel(s) : ME.status) : (s.balance == 0 ? "Paid" : "Unpaid"); }
function selectStmt(id) { selId = id; renderStatements(); }
function downloadPdf(id, inv) {                                        // saves the PDF straight to the Downloads folder
  toast("Preparing your statement...");
  fetch("/api/client/statements/" + id + "/pdf", { headers: { Authorization: "Bearer " + sessionStorage.getItem("fiberToken") }, cache: "no-store" }).then(function (r) {
    if (r.status == 401) { redirectToLogin("session-expired"); throw { status: 401 }; }
    if (r.status == 403) return r.json().then(function (d) {
      if (d.mustChangePassword) { redirectToLogin("password-reset"); throw { status: 401 }; }
      throw { message: d.error || "Could not create the PDF." };
    });
    if (!r.ok) throw { message: "Could not create the PDF." }; return r.blob();
  }).then(function (b) {
    var a = document.createElement("a"), u = URL.createObjectURL(b); a.href = u; a.download = "FiberTec-Statement-" + inv.replace(/[^A-Za-z0-9-]+/g, "") + ".pdf";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000); toast("Statement downloaded to your Downloads folder.");
  }).catch(function (e) { if (e && e.status != 401) toast((e && e.message) || "Download failed. Please try again.", "error"); });
}
function renderStatements() {
  var visibleStatements = STMT_FILTER ? STM.filter(function (s) { return s.month === STMT_FILTER; }) : STM;
  if (!visibleStatements.length) {
    $("stmt-table").innerHTML = "<tbody><tr><td class='muted'>No statements available for this month.</td></tr></tbody>";
    $("estmt").innerHTML = "";
    return;
  }
  if (!visibleStatements.some(function (m) { return m.id == selId; })) selId = visibleStatements[0].id;
  var pn = ME.plan.replace(/\s*\d+\s*Mbps/, ""), mb = (ME.plan.match(/\d+(?=\s*Mbps)/) || [""])[0];
  var t = "<thead><tr><th>STATEMENT</th><th>DUE</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>";
  visibleStatements.forEach(function (s) { t += "<tr class='" + (s.id == selId ? "sel" : "") + "' onclick='selectStmt(" + s.id + ")'><td><b>" + esc(s.inv) + "</b><small>" + esc(pn) + " " + mb + "</small></td><td>" + fmtD(s.due) + "</td><td>" + peso(s.amount) + "</td><td>" + pill(stmtStatus(s)) + "</td></tr>"; });
  $("stmt-table").innerHTML = t + "</tbody>";
  var s = visibleStatements.filter(function (x) { return x.id == selId; })[0], lbl = stmtStatus(s), isCur = s.id == cur().id;
  var recs = PAYS.filter(function (r) { return r.statement_id == s.id && r.status != "Rejected"; });
  var pays = recs.map(function (r) { return "<div class='est-ln'><span>" + r.method + " &middot; " + (r.reference_no ? "Ref " + fmtRef(r.reference_no) : "") + (r.reference_no && r.or_no ? " &middot; " : "") + (r.or_no ? "O.R. " + esc(r.or_no) : "") + "<small>" + fmtD(r.payment_date) + " &middot; " + (r.status == "Verified" ? "Verified" : "Awaiting verification") + "</small></span><span>" + peso(r.amount) + "</span></div>"; }).join("") || "<div class='est-ln'><span style='opacity:.5'>No payments yet</span><span></span></div>";
  $("estmt").innerHTML = "<div class='est-head'><div><h3>FiberTec IT Solutions</h3><small>E - STATEMENT</small></div><div class='r'><b>" + esc(s.inv) + "</b><small>Issued " + fmtD(s.bill) + "</small></div></div><div class='est-body'>" +
    "<div class='est-sum'><div><small>Status</small><b>" + lbl + "</b></div><div><small>Due date</small><b>" + fmtD(s.due, 1) + "</b></div><div><small>Amount due</small><b>" + peso(s.balance) + "</b></div></div>" +
    "<div class='est-h'><span>BILL TO</span><span>ACCOUNT</span></div><hr><div class='est-ln' style='align-items:flex-start'><span style='max-width:62%'><b>" + esc(ME.name.toUpperCase()) + "</b><small>" + esc(ME.address) + "</small></span><span style='text-align:right'>" + ME.no + "<small>" + esc(ME.branch.toUpperCase()) + " BRANCH</small></span></div>" +
    "<div class='est-h'><span>DESCRIPTION</span><span>AMOUNT</span></div><hr><div class='est-ln'><span>" + esc(ME.plan.toUpperCase()) + "<small>" + fmtD(s.bill, 1).toUpperCase() + " - " + fmtD(s.due, 1).toUpperCase() + ", " + s.due.slice(0, 4) + "</small></span><span>" + peso(s.amount) + "</span></div>" +
    "<div class='est-h'><span>PAYMENTS RECEIVED</span><span>" + peso(s.paid) + "</span></div><hr class='l'>" + pays + "<hr>" +
    "<div class='est-ln est-tot'><span>Total amount due</span><span>" + peso(s.balance) + "</span></div>" +
    "<div class='est-acts'>" + (isCur && canPayNow() ? "<button class='c-btn' onclick='showPage(\"payment\")'>Pay now</button>" : "") + "<button class='c-btn' style='background:#fff;color:#013f70;border:1px solid #013f70' onclick='downloadPdf(" + s.id + ",\"" + esc(s.inv) + "\")'>Download PDF</button>" + (isCur ? cancelBtn() : "") + "</div></div>";
}
function filterStatementHistory() {
  STMT_FILTER = $("statement-month").value;
  renderStatements();
}
function populateStatementMonths() {
  var select = $("statement-month");
  if (!select) return;
  var selected = STMT_FILTER;
  select.innerHTML = "<option value=''>All available months</option>" + STMT_MONTHS.map(function (month) {
    return "<option value='" + esc(month) + "'>" + esc(monthLabel(month)) + "</option>";
  }).join("");
  select.value = STMT_MONTHS.indexOf(selected) >= 0 ? selected : "";
  STMT_FILTER = select.value;
}

/* ---------- Cancellation request ---------- */
function requestCancel() {
  modal2("<div class='dlg-head'>Request cancellation<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'><p>Are you sure you want to cancel your FiberTec connection? This sends a request for account <b>" + ME.no + "</b> to your branch staff.</p>" +
    "<label>Reason</label><select id='cx-reason'><option>Moving to a new address</option><option>Switching provider</option><option>Financial reasons</option><option>No longer needs internet</option><option>Other</option></select>" +
    "<label>Enter your password to confirm</label><input type='password' id='cx-pw' autocomplete='current-password'><p class='error' id='cx-err'></p>" +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>No, keep my connection</button><button class='btn btn-red' onclick='runLockedButton(this, confirmCancel)'>Yes, cancel my connection</button></div></div>", "sm");
}
function confirmCancel() {
  var pw = val("cx-pw"); if (!pw) { $("cx-err").innerHTML = "Please enter your password."; return; }
  if (/\s/.test(pw)) { $("cx-err").innerHTML = "Password must not contain whitespace."; return; }
  return apiCall("POST", "/api/client/cancellation", { reason: val("cx-reason"), password: pw }).then(function () { closeModal(); toast("Cancellation request sent to your branch staff."); return loadAll(); })
    .then(renderClient).catch(function (e) { if (e && e.status != 401) $("cx-err").innerHTML = esc((e && e.message) || "Could not send the request."); });
}

/* ---------- Notifications (bell): red dot while anything is unread, unread items are highlighted ---------- */
function ago(v) {
  var s = Math.max(0, (Date.now() - Date.parse(v)) / 1000), u = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (var i = 0; i < u.length; i++) if (s >= u[i][1]) { var n = Math.floor(s / u[i][1]); return n + " " + u[i][0] + (n == 1 ? "" : "s") + " ago"; }
  return "Just now";
}
function noteItem(n) {
  var first = ME.name.split(" ")[0], a = n.amount != null ? pesoPlain(n.amount) : "", d = n.due_date ? fmtD(n.due_date) : "", t, b;
  if (n.notice_type == "7-Day Billing Notice") { t = "e-Statement ready: " + a + " due " + d; b = "Hi " + first + ",\n\nyour e-Statement " + n.invoice_no + " is ready. Amount due: " + a + ".\n\nDue date: " + d + ".\n\nOn or before the due date you can pay in full, or pay half. Pay with GCash and submit your 13-digit reference number in the portal, or pay in cash at the " + ME.branch + " branch."; }
  else if (n.notice_type == "Disconnection Warning") { t = "Payment overdue: " + a + " was due " + d; b = "Hi " + first + ",\n\nyour e-Statement " + (n.invoice_no || "") + " is overdue and your account is now in the grace period. Please pay the full balance before the grace period ends to avoid disconnection."; }
  else if (n.notice_type == "Payment Receipt") { t = "Payment received"; b = "Hi " + first + ",\n\n" + (n.message || "we received your payment. Thank you!"); }
  else { t = n.message && /could not match/.test(n.message) ? "Payment not accepted" : "Notice from FiberTec"; b = "Hi " + first + ",\n\n" + (n.message || "Please check your account for details."); }
  return { id: n.notice_id, title: t, body: b, when: ago(n.created_at), read: n.is_read };
}
function unreadCount() { return NOTIFS.filter(function (n) { return !n.read; }).length; }
function updateDot() { var c = unreadCount(), d = $("bell-dot"); if (d) d.style.display = c ? "block" : "none"; var m = $("mark-all"); if (m) m.style.display = c ? "" : "none"; }
function renderNotifications() {
  NOTIFS = NOTES.map(noteItem); var un = unreadCount();
  if (PREV_UNREAD !== null && un > PREV_UNREAD) toast("You have a new notification.");
  PREV_UNREAD = un; updateDot();
  var dd = ""; NOTIFS.slice(0, 5).forEach(function (n) { dd += "<div class='c-dd-item" + (n.read ? "" : " unread") + "' onclick='openNotif(" + n.id + ")'>" + esc(n.title) + "<small>" + n.when + (n.read ? "" : " &middot; <b class='newtag'>NEW</b>") + "</small><a>View full notification</a></div>"; });
  $("dd-list").innerHTML = dd || "<p class='muted' style='padding:12px 16px'>No notifications yet.</p>";
  if (!NOTIFS.length) { $("n-list").innerHTML = ""; $("n-view").innerHTML = "<p class='muted' style='padding:20px'>No notifications yet.</p>"; return; }
  if (!NOTIFS.some(function (n) { return n.id == SEL_N; })) SEL_N = (NOTIFS.filter(function (n) { return !n.read; })[0] || NOTIFS[0]).id;
  drawNotif(SEL_N, !$("notifications").classList.contains("hidden"));
}
function drawNotif(id, markRead) {
  SEL_N = id; var cur = NOTIFS.filter(function (n) { return n.id == id; })[0]; if (!cur) return;
  if (markRead && !cur.read) { cur.read = true; apiCall("POST", "/api/client/notices/" + id + "/read").catch(function () {}); updateDot(); }
  var l = ""; NOTIFS.forEach(function (n) { l += "<div class='c-nitem " + (n.id == id ? "sel " : "") + (n.read ? "" : "unread") + "' onclick='drawNotif(" + n.id + ",true)'><img src='images/icons/edit.png' alt=''><div>" + esc(n.title) + "<small>" + n.when + "</small></div>" + (n.read ? "" : "<i class='udot' title='Unread'></i>") + "</div>"; });
  $("n-list").innerHTML = l; $("n-view").innerHTML = "<div class='nh'><img src='images/icons/edit.png' alt=''><div><h2>" + esc(cur.title) + "</h2><small>" + cur.when + "</small></div></div><div class='nb'>" + esc(cur.body) + "</div>";
  var dd = $("dd-list"); if (dd) renderDd();
}
function renderDd() {
  var dd = ""; NOTIFS.slice(0, 5).forEach(function (n) { dd += "<div class='c-dd-item" + (n.read ? "" : " unread") + "' onclick='openNotif(" + n.id + ")'>" + esc(n.title) + "<small>" + n.when + (n.read ? "" : " &middot; <b class='newtag'>NEW</b>") + "</small><a>View full notification</a></div>"; });
  $("dd-list").innerHTML = dd;
}
function openNotif(id) { SEL_N = id; showPage("notifications"); drawNotif(id, true); }
function markAllRead() {
  apiCall("POST", "/api/client/notices/read-all").catch(function () {});
  NOTIFS.forEach(function (n) { n.read = true; NOTES.forEach(function (x) { x.is_read = true; }); }); updateDot(); renderDd(); drawNotif(SEL_N, false);
}

/* ---------- load everything from the database ---------- */
function loadAll() {
  return Promise.all([
    apiCall("GET", "/api/client/me"),
    apiCallAllPages("/api/client/statements"),
    apiCallAllPages("/api/client/payments"),
    apiCallAllPages("/api/client/notices"),
    apiCall("GET", "/api/client/statement-months")
  ]).then(function (r) {
    var d = r[0]; ME = { no: d.account_no, name: d.name, email: d.email, address: d.address, branch: d.branch, plan: d.plan_name, rate: Number(d.monthly_rate), totalBalance: Number(d.total_balance || 0), previousBalance: Number(d.previous_balance || 0), currentMonthDue: Number(d.current_month_due || 0), status: d.status, reason: d.status_reason, graceEnd: d.grace_end_date, installed: d.installed_date || d.registered_date, device: d.router_location || "-", due: Number(d.due_day), hasPending: d.has_pending, cancel: d.cancel };
    STM = r[1].map(mapStmt); PAYS = r[2]; NOTES = r[3]; STMT_MONTHS = r[4];
    populateStatementMonths();
  });
}
function clientDataSignature() {
  return JSON.stringify([
    ME,
    STM.map(function (s) { return [s.id, s.inv, s.bill, s.due, s.amount, verifiedPaid(s), remainingBalance(s), s.pay]; }),
    STMT_MONTHS, PAYS,
    NOTES
  ]);
}
function pollClientData() {
  if (BUSYP || liveRefreshPaused()) return;
  loadAll().then(function () {
    if (liveRefreshPaused()) return;
    if (clientDataSignature() !== CLIENT_RENDERED_SIGNATURE) renderPreservingScroll(renderClient);
  }).catch(function () {});
}
if ($("c-cards") && requireRole("client")) {
  loadAll().then(function () { showPage("home"); setInterval(pollClientData, 15000); })
    .catch(function (e) {
      if (e && e.status != 401) toast((e && e.message) || "Cannot reach the server.", "error");
      $("history").innerHTML = "<p class='muted'>Unable to load payments. Please check the connection banner above.</p>";
      $("stmt-table").innerHTML = "<tbody><tr><td class='muted'>Unable to load statements. Please check the connection banner above.</td></tr></tbody>";
    });
}
