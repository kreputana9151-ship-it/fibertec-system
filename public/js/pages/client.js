/* FiberTec - Client portal (live PostgreSQL API) */
var ME = null;
var LIVE_STMTS = [];
var LIVE_PAYS = [];
var LIVE_NOTICES = [];
var CPAGES = ["home", "payment", "statement", "notifications"];
var selIdx = 0;

function isoDate(d) {
  if (!d) return "";
  return String(d).slice(0, 10);
}
function acctLabelLive(m) {
  var code = (typeof branchOf == "function" && branchOf(m.branch)) ? branchOf(m.branch).code : "";
  var seq = String(m.account_no || "").slice(-4);
  return code ? ("B" + Number(code) + " - " + seq) : m.account_no;
}
function curStmt() {
  return LIVE_STMTS[0] || (ME && ME.current_statement) || null;
}
function hasPendingPayment() {
  return LIVE_PAYS.some(function (p) { return p.status == "Pending"; });
}
function inBillingLive() {
  return ME && (ME.status == "Active" || ME.status == "Grace Period");
}
function cycleLabel(s) {
  if (!s) return ME ? ME.status : "";
  if (Number(s.balance) <= 0 || s.payment_status == "Paid") return "Paid";
  if (hasPendingPayment()) return "Awaiting verification";
  if (Number(s.amount_paid || 0) > 0 || s.payment_status == "Partially Paid") return "Partially paid";
  var d = dayDiff(isoDate(s.due_date), APP_TODAY);
  return d == 0 ? "Due today" : d > 0 ? "Due in " + d + " day" + (d == 1 ? "" : "s") : "Overdue";
}
function pillClass(l) {
  return l == "Paid" ? "paid" : (l == "Awaiting verification" || l == "Partially paid") ? "wait" : (l == "Overdue" || l == "Rejected") ? "rej" : "";
}
function pill(l, id) {
  return "<span class='c-pill " + pillClass(l) + "'" + (id ? " id='" + id + "'" : "") + ">" + esc(l) + "</span>";
}
function canPayNow() {
  var s = curStmt();
  return inBillingLive() && s && Number(s.balance) > 0 && !hasPendingPayment();
}

function loadClientPortal(afterRender) {
  Promise.all([
    apiCall("GET", "/api/client/me"),
    apiCall("GET", "/api/client/statements").catch(function () { return []; }),
    apiCall("GET", "/api/client/payments").catch(function () { return []; }),
    apiCall("GET", "/api/client/notices").catch(function () { return []; })
  ]).then(function (res) {
    ME = res[0];
    if (!ME) { logout(); return; }
    LIVE_STMTS = Array.isArray(res[1]) ? res[1] : [];
    LIVE_PAYS = Array.isArray(res[2]) ? res[2] : [];
    LIVE_NOTICES = Array.isArray(res[3]) ? res[3] : [];
    $("c-welcome").innerHTML = "WELCOME " + esc(ME.name.toUpperCase());
    if (afterRender) afterRender();
    else renderClient();
  }).catch(function (e) {
    if (e && e.status != 401) toast((e && e.message) || "Failed to load account data.", "error");
  });
}

function myHistory() {
  return LIVE_PAYS.slice().sort(function (a, b) {
    var da = isoDate(a.payment_date || a.created_at), db = isoDate(b.payment_date || b.created_at);
    return da < db ? 1 : da > db ? -1 : Number(b.payment_id || 0) - Number(a.payment_id || 0);
  }).map(function (r) {
    var dt = isoDate(r.payment_date || r.created_at);
    return {
      method: r.method || "GCash",
      type: r.payment_type || "Payment",
      ref: r.reference_no ? fmtRef(r.reference_no) : "",
      or: r.or_no || "",
      date: dt ? "Submitted " + fmtD(dt, 1) : "",
      amount: Number(r.amount || 0),
      status: r.status == "Verified" ? "Paid" : r.status == "Pending" ? "Awaiting verification" : "Rejected"
    };
  });
}
function histRows(list) {
  return list.map(function (e) {
    return "<div class='c-row'>" + esc(e.method) + " &middot; " + esc(e.type) +
      (e.ref ? " <span class='m'>&middot; client reference &middot;</span> " + esc(e.ref) : "") +
      (e.or ? " <span class='m'>&middot; official receipt &middot;</span> " + esc(e.or) : "") +
      "<span class='amt'>" + peso(e.amount) + "</span><span class='sd'>" + esc(e.date) + "</span><span class='st'>" + pill(e.status) + "</span></div>";
  }).join("") || "<p class='muted'>No payments yet.</p>";
}
function showPage(id) {
  CPAGES.forEach(function (p) { $(p).classList.add("hidden"); var n = $("nav-" + p); if (n) n.classList.remove("on"); });
  $(id).classList.remove("hidden");
  var on = $("nav-" + id); if (on) on.classList.add("on");
  $("bell").classList.add("hidden");
  window.scrollTo(0, 0);
  if (ME) renderClient();
}
function toggleBell() { $("bell").classList.toggle("hidden"); }

/* ---------- Direct PDF File Download ---------- */
function downloadClientStatementPDF(idx) {
  var s = LIVE_STMTS[idx != null ? idx : selIdx] || curStmt();
  if (!s) { toast("No statement available to download."); return; }
  var dueISO = isoDate(s.due_date);
  var billISO = isoDate(s.billing_month || s.issued_date || dueISO);
  var end = addDays(dueISO, 30);
  var lbl = stmtStatus(s);
  var recs = LIVE_PAYS.filter(function (r) {
    return r.status != "Rejected" && (!r.statement_id || String(r.statement_id) == String(s.statement_id));
  });

  var payRows = recs.length
    ? recs.map(function (r) {
        return "<tr><td>" + fmtD(isoDate(r.payment_date || r.created_at), 1) + "</td><td>" + esc(r.method || "GCash") + "</td><td>" + esc(r.reference_no ? fmtRef(r.reference_no) : "-") + "</td><td>" + esc(r.or_no || "-") + "</td><td>" + (r.status == "Verified" ? "Verified" : "Awaiting verification") + "</td><td style='text-align:right'>" + peso(r.amount) + "</td></tr>";
      }).join("")
    : "<tr><td colspan='6' style='color:#777;font-style:italic'>No payments recorded for this statement yet.</td></tr>";

  var wrap = document.createElement("div");
  wrap.innerHTML =
    "<div style='font-family:Arial,sans-serif;color:#1b2a4a;padding:28px;background:#fff'>" +
    "<style>.pdf-top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #013f70;padding-bottom:14px}" +
    ".pdf-top h1{margin:0;color:#013f70;font-size:22px}.pdf-tag{font-size:12px;letter-spacing:1.5px;color:#5197d7;font-weight:bold}" +
    ".pdf-sum{display:flex;gap:24px;background:#f4f7fb;padding:12px 16px;border-radius:8px;margin:18px 0}" +
    ".pdf-sum div{flex:1}.pdf-sum small{display:block;color:#666;font-size:11px;text-transform:uppercase}.pdf-sum b{font-size:15px;color:#013f70}" +
    ".pdf-grid{display:flex;justify-content:space-between;margin:18px 0;font-size:13px;line-height:1.6}" +
    ".pdf-tbl{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px}" +
    ".pdf-tbl th{text-align:left;background:#013f70;color:#fff;padding:8px 10px;font-size:11px;letter-spacing:.5px}" +
    ".pdf-tbl td{padding:8px 10px;border-bottom:1px solid #e2e8f0}" +
    ".pdf-tot{display:flex;justify-content:space-between;font-size:16px;font-weight:bold;border-top:2px solid #013f70;padding-top:10px;color:#013f70}</style>" +
    "<div class='pdf-top'><div><h1>FiberTec IT Solutions</h1><div class='pdf-tag'>E - STATEMENT</div></div>" +
    "<div style='text-align:right'><strong style='font-size:16px'>" + esc(s.invoice_no) + "</strong><br><small>Issued " + fmtD(billISO) + "</small></div></div>" +
    "<div class='pdf-sum'><div><small>Status</small><b>" + esc(lbl) + "</b></div><div><small>Due Date</small><b>" + fmtD(dueISO, 1) + "</b></div><div><small>Amount Due</small><b>" + peso(s.balance) + "</b></div></div>" +
    "<div class='pdf-grid'><div><strong>BILL TO</strong><br><b>" + esc(ME.name.toUpperCase()) + "</b><br>" + esc(ME.address) + "<br>" + esc(ME.email) + "</div>" +
    "<div style='text-align:right'><strong>ACCOUNT</strong><br>" + esc(acctLabelLive(ME)) + " (" + esc(ME.account_no) + ")<br>" + esc(ME.branch.toUpperCase()) + " BRANCH</div></div>" +
    "<table class='pdf-tbl'><thead><tr><th>DESCRIPTION</th><th>BILLING PERIOD</th><th style='text-align:right'>AMOUNT</th></tr></thead><tbody>" +
    "<tr><td>" + esc(ME.plan_name.toUpperCase()) + "</td><td>" + fmtD(dueISO, 1).toUpperCase() + " - " + fmtD(end, 1).toUpperCase() + ", " + end.slice(0, 4) + "</td><td style='text-align:right'>" + peso(s.amount) + "</td></tr></tbody></table>" +
    "<table class='pdf-tbl'><thead><tr><th>DATE</th><th>METHOD</th><th>REF NO.</th><th>O.R. NO.</th><th>STATUS</th><th style='text-align:right'>AMOUNT</th></tr></thead><tbody>" + payRows + "</tbody></table>" +
    "<div class='pdf-tot'><span>Total amount due</span><span>" + peso(s.balance) + "</span></div></div>";

  var fileName = String(s.invoice_no || "statement").replace(/\s+/g, "") + ".pdf";
  if (typeof html2pdf !== "undefined") {
    toast("Downloading " + fileName + "...");
    html2pdf().set({
      margin: 10,
      filename: fileName,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
    }).from(wrap).save();
  } else {
    toast("PDF generator still loading. Please try again in a second.");
  }
}

/* ---------- Cancellation banner + button state ---------- */
function cancelState() {
  var pendingCx = sessionStorage.getItem("fiberCxPending_" + ME.account_no);
  if (ME.status == "Terminated") return { banner: "<div class='c-banner red'><b>Your account has been terminated.</b> Please contact your branch if you want to be reconnected.</div>", can: false };
  if (ME.status == "Under Review") return { banner: "<div class='c-banner blue'><b>Your account is currently under review.</b> We will notify you once it is finalized.</div>", can: false };
  if (pendingCx) return { banner: "<div class='c-banner amber'><b>Cancellation request sent</b> on " + fmtD(pendingCx) + ". Branch staff are reviewing it.</div>", can: false, pending: true };
  if (ME.status == "Grace Period") return { banner: "<div class='c-banner amber'><b>Your account is in the grace period.</b> Please settle your balance by " + fmtD(isoDate(ME.grace_end_date)) + " to avoid disconnection.</div>", can: true };
  return { banner: "", can: true };
}
function cancelBtn() {
  var st = cancelState();
  return st.can || st.pending ? "<button class='c-btn ghost' " + (st.pending ? "disabled" : "") + " onclick='requestCancel()'>" + (st.pending ? "Cancellation pending" : "Request cancellation") + "</button>" : "";
}

function renderClient() {
  if (!ME) return;
  var s = curStmt();
  var label = inBillingLive() ? cycleLabel(s) : ME.status;
  var dueISO = s ? isoDate(s.due_date) : APP_TODAY;
  var nextDue = addDays(dueISO, 30);
  var dueDay = Number(dueISO.slice(8, 10)) || 21;
  var bal = s ? Number(s.balance) : 0;
  var paid = s ? Number(s.amount_paid || (Number(s.amount) - bal)) : 0;
  var st = cancelState();

  $("c-banner").innerHTML = st.banner;
  $("c-name").innerHTML = esc(ME.name.toUpperCase());
  $("c-av").innerHTML = initials(ME.name);

  var mbps = (ME.plan_name.match(/\d+(?=\s*Mbps)/i) || ["0"])[0];
  var pn = ME.plan_name.replace(/\s*\d+\s*Mbps/i, "").trim();

  $("c-cards").innerHTML =
    "<div class='c-card'><p class='c-lab'>SUBSCRIPTION</p><p class='c-big'>" + mbps + " Mbps</p><p class='c-sub'><b>" + esc(pn) + " " + mbps + "</b> &middot; <b>" + peso(ME.monthly_rate) + "/month</b></p></div>" +
    "<div class='c-card'><p class='c-lab'>CURRENT BALANCE</p><p class='c-big'>" + peso(bal) + "</p>" + pill(label) + "</div>" +
    "<div class='c-card'><p class='c-lab'>DUE DATE</p><p class='c-big' style='font-size:32px;margin-top:16px'>" + fmtD(dueISO) + "</p><p class='c-sub'>balance " + peso(bal) + "</p></div>" +
    "<div class='c-card'><p class='c-lab'>DAYS LEFT IN CYCLE</p><p class='c-big'>" + Math.max(0, dayDiff(nextDue, APP_TODAY)) + "</p><p class='c-sub'>Next statement " + fmtD(nextDue) + ". Billing date stays on the " + ordinal(dueDay) + " even if you change plan</p></div>";

  $("c-acct").innerHTML =
    "<h3>Your Account</h3>" +
    "<div class='c-kv'><b>Account no.</b><span>" + esc(acctLabelLive(ME)) + " &nbsp;<span class='muted'>(" + esc(ME.account_no) + ")</span></span></div>" +
    "<div class='c-kv'><b>Address</b><span>" + esc(ME.address || "-") + "</span></div>" +
    "<div class='c-kv'><b>Branch</b><span>" + esc(ME.branch) + "</span></div>" +
    "<div class='c-kv'><b>Contact</b><span>" + esc(ME.contact_no || "-") + "</span></div>" +
    "<div class='c-kv'><b>Status</b><span>" + esc(ME.status) + "</span></div>" +
    "<div class='c-kv'><b>Email</b><span>" + esc(ME.email || "-") + "</span></div>" +
    "<div class='c-btns'><button class='c-btn' onclick='showPage(\"payment\")'>Pay now</button><button class='c-btn' onclick='showPage(\"statement\")'>View statements</button>" + cancelBtn() + "</div>";

  var h = myHistory();
  $("recent").innerHTML = histRows(h.slice(0, 4));
  $("history").innerHTML = histRows(h);

  $("p-acct").innerHTML = s ? esc(s.invoice_no) : "-";
  var pp = $("p-pill"); pp.className = "c-pill " + pillClass(label); pp.textContent = label;
  $("p-due").innerHTML = s ? ("Due " + fmtD(dueISO) + " &nbsp; Paid " + peso(paid) + " of " + peso(ME.monthly_rate)) : "No active statement";
  $("p-branch").innerHTML = esc(ME.branch);
  $("paytype").style.display = canPayNow() ? "" : "none";
  if (!canPayNow()) $("steps23").classList.add("hidden");
  $("p-blocked").innerHTML = !inBillingLive()
    ? "Payments are not available while your account is " + ME.status.toLowerCase() + "."
    : hasPendingPayment()
    ? "Your payment is waiting for staff verification."
    : bal <= 0
    ? "You are fully paid for this statement. Thank you!"
    : "";

  renderStatements();
  renderNotifications();
}

function updatePay() {
  var t = val("paytype"), s = curStmt();
  if (!s) return;
  var bal = Number(s.balance), rate = Number(ME.monthly_rate);
  $("steps23").classList.toggle("hidden", t == "");
  $("partialnote").classList.toggle("hidden", t != "partial");
  $("payamt").innerHTML = peso(t == "partial" ? Math.min(rate / 2, bal) : bal);
}
function cancelPay() { $("ref").value = ""; $("referr").innerHTML = ""; $("paytype").value = ""; updatePay(); }

function submitPayment() {
  var ref = val("ref").replace(/\s/g, ""), t = val("paytype"), s = curStmt();
  if (!/^[0-9]{13}$/.test(ref)) { $("referr").innerHTML = "Reference number must be exactly 13 digits."; return; }
  if (!s || !s.statement_id) { $("referr").innerHTML = "No open statement found to pay."; return; }
  var bal = Number(s.balance), rate = Number(ME.monthly_rate);
  var amt = t == "partial" ? Math.min(rate / 2, bal) : bal;

  apiCall("POST", "/api/client/payments", {
    statementId: Number(s.statement_id),
    amount: amt,
    referenceNo: ref
  }).then(function () {
    cancelPay();
    toast("Payment submitted. Branch staff will verify it shortly.");
    loadClientPortal();
  }).catch(function (e) {
    if (e && e.status != 401) {
      $("referr").innerHTML = esc((e && e.message) || "Could not submit payment.");
    }
  });
}

/* ---------- Statements ---------- */
function stmtStatus(s) {
  if (!s) return "";
  if (s === curStmt()) return inBillingLive() ? cycleLabel(s) : ME.status;
  return Number(s.balance) <= 0 || s.payment_status == "Paid" ? "Paid" : "Unpaid";
}
function selectStmt(idx) { selIdx = idx; renderStatements(); }
function renderStatements() {
  if (!LIVE_STMTS.length) {
    $("stmt-table").innerHTML = "<tbody><tr><td class='muted'>No statements yet.</td></tr></tbody>";
    $("estmt").innerHTML = "";
    return;
  }
  if (selIdx >= LIVE_STMTS.length) selIdx = 0;
  var mbps = (ME.plan_name.match(/\d+(?=\s*Mbps)/i) || [""])[0];
  var pn = ME.plan_name.replace(/\s*\d+\s*Mbps/i, "").trim();

  var t = "<thead><tr><th>STATEMENT</th><th>DUE</th><th>TOTAL</th><th>STATUS</th></tr></thead><tbody>";
  LIVE_STMTS.forEach(function (s, idx) {
    t += "<tr class='" + (idx == selIdx ? "sel" : "") + "' onclick='selectStmt(" + idx + ")'>" +
      "<td><b>" + esc(s.invoice_no) + "</b><small>" + esc(pn) + " " + mbps + "</small></td>" +
      "<td>" + fmtD(isoDate(s.due_date)) + "</td>" +
      "<td>" + peso(s.amount) + "</td>" +
      "<td>" + pill(stmtStatus(s)) + "</td></tr>";
  });
  $("stmt-table").innerHTML = t + "</tbody>";

  var s = LIVE_STMTS[selIdx], lbl = stmtStatus(s);
  var dueISO = isoDate(s.due_date);
  var billISO = isoDate(s.billing_month || s.issued_date || dueISO);
  var end = addDays(dueISO, 30);
  var paidAmt = Number(s.amount_paid || (Number(s.amount) - Number(s.balance)));
  var recs = LIVE_PAYS.filter(function (r) {
    return r.status != "Rejected" && (!r.statement_id || String(r.statement_id) == String(s.statement_id));
  });

  var pays = recs.map(function (r) {
    return "<div class='est-ln'><span>" + esc(r.method || "GCash") + " &middot; " +
      (r.reference_no ? "Ref " + fmtRef(r.reference_no) : "") +
      (r.reference_no && r.or_no ? " &middot; " : "") +
      (r.or_no ? "O.R. " + esc(r.or_no) : "") +
      "<small>" + fmtD(isoDate(r.payment_date || r.created_at)) + " &middot; " + (r.status == "Verified" ? "Verified" : "Awaiting verification") + "</small></span>" +
      "<span>" + peso(r.amount) + "</span></div>";
  }).join("") || "<div class='est-ln'><span style='opacity:.5'>No payments yet</span><span></span></div>";

  $("estmt").innerHTML =
    "<div class='est-head'><div><h3>FiberTec IT Solutions</h3><small>E - STATEMENT</small></div><div class='r'><b>" + esc(s.invoice_no) + "</b><small>Issued " + fmtD(billISO) + "</small></div></div>" +
    "<div class='est-body'>" +
    "<div class='est-sum'><div><small>Status</small><b>" + esc(lbl) + "</b></div><div><small>Due date</small><b>" + fmtD(dueISO, 1) + "</b></div><div><small>Amount due</small><b>" + peso(s.balance) + "</b></div></div>" +
    "<div class='est-h'><span>BILL TO</span><span>ACCOUNT</span></div><hr><div class='est-ln' style='align-items:flex-start'><span style='max-width:62%'><b>" + esc(ME.name.toUpperCase()) + "</b><small>" + esc(ME.address || "-") + "</small></span><span style='text-align:right'>" + esc(acctLabelLive(ME)) + "<small>" + esc(ME.branch.toUpperCase()) + " BRANCH</small></span></div>" +
    "<div class='est-h'><span>DESCRIPTION</span><span>AMOUNT</span></div><hr><div class='est-ln'><span>" + esc(ME.plan_name.toUpperCase()) + "<small>" + fmtD(dueISO, 1).toUpperCase() + " - " + fmtD(end, 1).toUpperCase() + ", " + end.slice(0, 4) + "</small></span><span>" + peso(s.amount) + "</span></div>" +
    "<div class='est-h'><span>PAYMENTS RECEIVED</span><span>" + peso(paidAmt) + "</span></div><hr class='l'>" + pays + "<hr>" +
    "<div class='est-ln est-tot'><span>Total amount due</span><span>" + peso(s.balance) + "</span></div>" +
    "<div class='est-acts'>" + (selIdx == 0 && canPayNow() ? "<button class='c-btn' onclick='showPage(\"payment\")'>Pay now</button>" : "") +
    "<button class='c-btn' style='background:#fff;color:#013f70;border:1px solid #013f70' onclick='downloadClientStatementPDF(" + selIdx + ")'>Download PDF</button>" +
    (selIdx == 0 ? cancelBtn() : "") + "</div></div>";
}

/* ---------- Cancellation request ---------- */
function requestCancel() {
  modal2("<div class='dlg-head'>Request cancellation<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'><p>Are you sure you want to cancel your FiberTec connection? This sends a request for account <b>" + esc(acctLabelLive(ME)) + "</b> to your branch staff.</p>" +
    "<label>Reason</label><select id='cx-reason'><option>Moving to a new address</option><option>Switching provider</option><option>Financial reasons</option><option>No longer needs internet</option><option>Other</option></select>" +
    "<label>Enter your password to confirm</label><input type='password' id='cx-pw' autocomplete='current-password'><p class='error' id='cx-err'></p>" +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>No, keep my connection</button><button class='btn btn-red' onclick='confirmCancel()'>Yes, cancel my connection</button></div></div>", "sm");
}
function finalizeCancel() {
  var reason = val("cx-reason");
  apiCall("POST", "/api/client/cancellation", { reason: reason }).then(function () {
    sessionStorage.setItem("fiberCxPending_" + ME.account_no, APP_TODAY);
    closeModal();
    toast("Cancellation request sent to your branch staff.");
    loadClientPortal();
  }).catch(function (e) {
    if (e && e.status == 409) {
      sessionStorage.setItem("fiberCxPending_" + ME.account_no, APP_TODAY);
      closeModal();
      renderClient();
      toast(e.message || "You already have a pending request.");
      return;
    }
    if (e && e.status != 401) {
      $("cx-err").innerHTML = esc((e && e.message) || "Could not submit cancellation.");
    }
  });
}
function confirmCancel() {
  var pw = val("cx-pw");
  if (!pw) { $("cx-err").innerHTML = "Incorrect password. Cancellation was not submitted."; return; }
  var storedPw = sessionStorage.getItem("fiberPw");
  if (storedPw) {
    if (pw != storedPw) { $("cx-err").innerHTML = "Incorrect password. Cancellation was not submitted."; return; }
    finalizeCancel();
    return;
  }
  api("login", { loginId: ME.account_no, password: pw })
    .then(function (r) {
      if (!r.ok) throw new Error("Invalid password");
      sessionStorage.setItem("fiberPw", pw);
      finalizeCancel();
    })
    .catch(function () {
      $("cx-err").innerHTML = "Incorrect password. Cancellation was not submitted.";
    });
}

/* ---------- Notifications ---------- */
var NOTIFS = [];
function renderNotifications() {
  NOTIFS = [];
  var first = ME.name.split(" ")[0];
  if (LIVE_NOTICES.length) {
    LIVE_NOTICES.forEach(function (n) {
      var dt = fmtD(isoDate(n.notice_date || n.created_at));
      NOTIFS.push([n.notice_type || "FiberTec Notice", dt, n.message || n.body || ("Hi " + first + ",\n\nNotice: " + (n.notice_type || "System Update") + " (" + dt + ").")]);
    });
  } else {
    LIVE_STMTS.forEach(function (s) {
      NOTIFS.push([
        "e-Statement ready: " + pesoPlain(s.amount) + " due " + fmtD(isoDate(s.due_date)),
        fmtD(isoDate(s.billing_month || s.due_date)),
        "Hi " + first + ",\n\nyour e-Statement " + s.invoice_no + " is ready. Amount due: " + pesoPlain(s.amount) + ".\n\nDue date: " + fmtD(isoDate(s.due_date)) + "."
      ]);
    });
    if (!NOTIFS.length) {
      NOTIFS.push(["Welcome to FiberTec Portal", "Today", "Hi " + first + ",\n\nyour account (" + ME.account_no + ") is connected to the live FiberTec portal."]);
    }
  }
  var dd = "";
  NOTIFS.slice(0, 5).forEach(function (n, i) {
    dd += "<div class='c-dd-item' onclick='openNotif(" + i + ")'>" + esc(n[0]) + "<small>" + esc(n[1]) + "</small><a>View full notification</a></div>";
  });
  $("dd-list").innerHTML = dd;
  if (!window._ni || window._ni >= NOTIFS.length) window._ni = 0;
  drawNotif(window._ni);
}
function drawNotif(i) {
  if (!NOTIFS[i]) return;
  window._ni = i;
  var l = "";
  NOTIFS.forEach(function (n, k) {
    l += "<div class='c-nitem " + (k == i ? "sel" : "") + "' onclick='drawNotif(" + k + ")'><img src='images/icons/edit.png' alt=''><div>" + esc(n[0]) + "<small>" + esc(n[1]) + "</small></div></div>";
  });
  $("n-list").innerHTML = l;
  $("n-view").innerHTML = "<div class='nh'><img src='images/icons/edit.png' alt=''><div><h2>" + esc(NOTIFS[i][0]) + "</h2><small>" + esc(NOTIFS[i][1]) + "</small></div></div><div class='nb'>" + esc(NOTIFS[i][2]) + "</div>";
}
function openNotif(i) { drawNotif(i); showPage("notifications"); }

if ($("c-cards") && requireRole("client")) {
  loadClientPortal(function () { showPage("home"); });
}