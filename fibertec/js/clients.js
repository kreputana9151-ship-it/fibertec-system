/* FiberTec - Clients records (shared by Admin and Staff) + client dialogs.
   Staff = view only. Only the Admin role may terminate or reactivate an account. */
var CV = { tab: "All" }, TABS = ["All", "Active", "Grace Period", "Under Review", "Terminated"];
var STAFF_BRANCH = sessionStorage.getItem("fiberBranch");
function isAdmin() { return ROLE == "admin"; }

function initClientsView() {
  fillSelect("f-branch", "All Branches", branchNames()); fillSelect("f-plan", "All Plans", planNames());
  if (!isAdmin() && STAFF_BRANCH) { $("f-branch").value = STAFF_BRANCH; $("f-branch").disabled = true; $("f-branch").title = "Staff can only see their own branch"; }
  renderClients();
}
function clientFilters(skipStatus) {
  var q = val("search").trim().toLowerCase(), b = val("f-branch"), p = val("f-plan");
  return clients.filter(function (c) {
    if (!isAdmin() && c.branch != STAFF_BRANCH) return false;
    if (b && c.branch != b) return false; if (p && c.plan != p) return false;
    if (!skipStatus && CV.tab != "All" && c.status != CV.tab) return false;
    if (q && (c.no + " " + c.name).toLowerCase().indexOf(q) < 0) return false; return true;
  });
}
function onClientFilter() { pgReset("clients"); renderClients(); }
function setClientTab(t) { CV.tab = t; pgReset("clients"); renderClients(); }
function clientCols(tab) {
  var act = isAdmin(), take = function (c) { return "<button class='action review' onclick='event.stopPropagation();reviewClient(\"" + c.no + "\")'>Take Action</button>"; };
  var cols = {
    "All": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Contact No.", function (c) { return c.contact; }], ["Email", function (c) { return esc(c.email); }], ["Branch", function (c) { return c.branch; }], ["Internet Plan", function (c) { return c.plan; }], ["Status", function (c) { return badgeFor(c.status); }]],
    "Active": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Branch", function (c) { return c.branch; }], ["Internet Plan", function (c) { return c.plan; }], ["Monthly Rate", function (c) { return peso(c.rate); }], ["Due Date", function (c) { return fmtD(c.dueISO, 1); }], ["Payment Status", function (c) { return badgeFor(c.pay); }]],
    "Grace Period": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Monthly Rate", function (c) { return peso(c.rate); }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Grace Period Ends", function (c) { return fmtD(c.graceEnd); }], ["Days Remaining", function (c) { return "<b>" + c.graceLeft + " Day" + (c.graceLeft == 1 ? "" : "s") + " Left</b>"; }]],
    "Under Review": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Branch", function (c) { return c.branch; }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Reason", function (c) { return esc(c.reason); }], ["Date Flagged", function (c) { return fmtD(c.flagged); }]],
    "Terminated": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Internet Plan", function (c) { return c.plan; }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Termination Date", function (c) { return fmtD(c.termDate); }], ["Payment Status", function (c) { return badgeFor(c.pay); }]]
  }[tab];
  if (act && tab == "Under Review") cols.push(["Action", take]);
  if (act && tab == "Terminated") cols.push(["Action", function (c) { return "<button class='action' onclick='event.stopPropagation();reactivate(\"" + c.no + "\")'>Take Action</button>"; }]);
  return cols;
}
function renderClients() {
  var base = clientFilters(true), t = "";
  TABS.forEach(function (tb) { var n = base.filter(function (c) { return tb == "All" || c.status == tb; }).length; t += "<button class='" + (tb == CV.tab ? "active" : "") + "' onclick='setClientTab(\"" + tb + "\")'>" + tb + "<em>" + n + "</em></button>"; });
  $("client-tabs").innerHTML = t;
  var rows = clientFilters(false), info = paginate("clients", rows), cols = clientCols(CV.tab), s = "<thead><tr>";
  cols.forEach(function (c) { s += "<th>" + c[0] + "</th>"; }); s += "</tr></thead><tbody>";
  info.rows.forEach(function (c) { s += "<tr class='click' onclick='viewClient(\"" + c.no + "\")'>"; cols.forEach(function (k) { s += "<td>" + k[1](c) + "</td>"; }); s += "</tr>"; });
  if (!rows.length) s += emptyRow(cols.length);
  $("client-table").innerHTML = s + "</tbody>"; $("client-foot").innerHTML = footHTML("clients", info, renderClients);
}
function exportClients() {
  var rows = clientFilters(false); downloadCSV("fibertec-clients.csv", [["Account No.", "Client Name", "Contact No.", "Email", "Branch", "Plan", "Status", "Payment Status"]].concat(rows.map(function (c) { return [c.no, c.name, c.contact, c.email, c.branch, c.plan, c.status, c.pay]; })));
  toast("Exported " + rows.length + " clients to CSV.");
}

/* ---------- View details (read-only; used by both portals) ---------- */
function viewClient(no) {
  var c = clientByNo(no), s = statement(c, "2026-10"), extra = "";
  if (c.status == "Under Review") extra = "<div class='cd-note'><div class='warn amber'><b>Under Review</b> &middot; " + esc(c.reason) + " &middot; flagged " + fmtD(c.flagged) + (isAdmin() ? "" : ". Waiting for an administrator's decision.") + "</div></div>";
  if (c.status == "Terminated") extra = "<div class='cd-note'><div class='warn red'><b>Terminated</b> on " + fmtD(c.termDate) + " &middot; " + esc(c.termReason || "Non-Payment") + "</div></div>";
  if (c.status == "Grace Period") extra = "<div class='cd-note'><div class='warn amber'><b>Grace period</b> ends " + fmtD(c.graceEnd) + " (" + c.graceLeft + " day" + (c.graceLeft == 1 ? "" : "s") + " left)</div></div>";
  modal2("<div class='cd-hero'><span class='avatar'>" + initials(c.name) + "</span><div><h2>" + esc(c.name) + "</h2><small>Account " + c.no + " &middot; " + c.branch + " Branch</small><div style='margin-top:8px'>" + badgeFor(c.status) + "</div></div><button class='x dlg-x' style='background:none;border:0;color:#fff;font-size:28px;cursor:pointer' onclick='closeModal()'>&times;</button></div>" +
    "<div class='cd-stats'><div class='cd-stat'><small>Plan</small><b>" + c.plan.replace(/\s*Mbps/, " Mbps") + "</b></div><div class='cd-stat'><small>Monthly rate</small><b>" + peso(c.rate) + "</b></div><div class='cd-stat'><small>Payment status</small><b>" + c.pay + "</b></div><div class='cd-stat'><small>Balance</small><b>" + peso(c.balance) + "</b></div></div>" + (extra ? "<div style='height:14px'></div>" + extra : "") +
    "<div class='cd-grid'><div class='cd-sec'><h4>Records</h4>" + kv("Branch", c.branch + " Branch") + kv("Plan", "FiberTec " + c.plan) + kv("Installed date", fmtD(c.installed)) + kv("Monthly rate", peso(c.rate)) + kv("Payment due date", "Every " + ordinal(c.due)) + "</div>" +
    "<div class='cd-sec'><h4>Address and contact</h4>" + kv("Address", esc(c.address)) + kv("Contact no.", c.contact) + kv("Email", esc(c.email)) + kv("FB / Messenger", esc(c.fb)) + "</div>" +
    "<div class='cd-sec'><h4>Current statement</h4>" + kv("Invoice no.", s.inv) + kv("Billing date", fmtD(s.bill)) + kv("Due date", fmtD(s.due)) + kv("Paid / due", peso(s.paid) + " / " + peso(s.amount)) + "</div>" +
    "<div class='cd-sec'><h4>Connection device location</h4><p style='margin:6px 0 0'>" + esc(c.device) + "</p></div></div>" +
    (isAdmin() ? "" : "<div class='cd-note' style='padding-bottom:18px'><div class='view-only' style='margin:0'>View only. Only administrators can terminate or reactivate accounts.</div></div>"), "");
}

/* ---------- Admin actions ---------- */
function denyIfNotAdmin() { if (isAdmin()) return false; toast("Permission denied: only administrators can do this.", "error"); return true; }
function reviewClient(no) {
  if (denyIfNotAdmin()) return;
  var c = clientByNo(no), cancel = c.reason == "Client Cancellation Request";
  modal2("<div class='dlg-head'>Under Review &middot; Take Action<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    kv("Client", esc(c.name)) + kv("Account No.", c.no) + kv("Branch", c.branch) + kv("Outstanding Balance", peso(c.balance)) + kv("Reason", esc(c.reason)) + kv("Date flagged", fmtD(c.flagged)) +
    (cancel ? "<div class='warn blue'>The client asked to cancel this plan and branch staff approved the request. Terminate the account to finish the cancellation.</div>"
      : "<div class='warn amber'>Mark paid only after the settlement is verified. If no decision is made within 3 days, the account is terminated automatically.</div>") +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>Cancel</button>" + (cancel ? "" : "<button class='btn btn-green' onclick='markPaid(\"" + no + "\")'>Mark Paid</button>") + "<button class='btn btn-red' onclick='askTerminate(\"" + no + "\")'>Terminate</button></div></div>", "sm");
}
function askTerminate(no) {
  if (denyIfNotAdmin()) return; var c = clientByNo(no);
  confirmBox("Terminate account", "Are you sure you want to terminate <b>" + esc(c.name) + "</b> (" + c.no + ")? The account moves to the Terminated tab.", "Yes, terminate", function () { terminateClient(no); }, true);
}
function terminateClient(no) {
  if (denyIfNotAdmin()) return; var c = clientByNo(no);
  setClient(no, { status: "Terminated", termDate: APP_TODAY, termReason: c.reason == "Client Cancellation Request" ? "Client Cancellation Request" : "Non-Payment", reason: null, flagged: null, graceEnd: null });
  logActivity(c.branch, "Administrator terminated account of " + c.name + " (" + c.no + ")."); toast(c.name + " was terminated."); renderClients();
}
function markPaid(no) {
  if (denyIfNotAdmin()) return; var c = clientByNo(no);
  if (c.balance > 0) addRecord({ acc: c.no, name: c.name, branch: c.branch, amount: c.balance, method: "Cash", ref: "", or: "OR-" + (10000 + Math.floor(Math.random() * 89999)), status: "Verified", type: "Settlement" });
  setClient(no, { status: "Active", reason: null, flagged: null }); closeModal(); toast(c.name + " is marked paid and active again."); renderClients();
}
function reactivate(no) {
  if (denyIfNotAdmin()) return;
  var c = clientByNo(no), blocked = c.pay == "Unpaid" || c.pay == "Pending";
  modal2("<div class='dlg-head'>&#8635; Reactivate Client Account<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    "<p class='muted'>Review the client's payment and account status before reactivation.</p>" + kv("Client", esc(c.name) + " (" + c.no + ")") + kv("Termination Reason", esc(c.termReason || "Non-Payment")) + kv("Outstanding Balance", peso(c.balance)) + kv("Payment Status", badgeFor(c.pay)) +
    (blocked ? "<div class='warn amber' id='re-warn'><b>Cannot reactivate yet.</b> Payment status is <b>" + c.pay + "</b>. The account can only be reactivated once the payment is verified (status Paid).</div>" : "<div class='warn blue'>Payment is settled. This account can be reactivated.</div>") +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>Cancel</button><button class='btn btn-green " + (blocked ? "blocked" : "") + "' onclick='doReactivate(\"" + no + "\")'>Reactivate Account</button></div></div>", "sm");
}
function doReactivate(no) {
  var c = clientByNo(no);
  if (c.pay == "Unpaid" || c.pay == "Pending") { var w = $("re-warn"); w.className = "warn red shake"; w.innerHTML = "<b>Reactivation blocked.</b> You cannot reactivate an account while its payment status is " + c.pay + ". Ask branch staff to verify the payment first."; return; }
  setClient(no, { status: "Active", termDate: null, termReason: null, reason: null }); closeModal(); logActivity(c.branch, "Administrator reactivated account of " + c.name + " (" + c.no + ")."); toast(c.name + " was reactivated."); renderClients();
}

/* ---------- Register a new client ---------- */
function openRegister() {
  var opts = BRANCHES.map(function (b) { return "<option value='" + b.name + "'>" + b.code + " - " + b.name + "</option>"; }).join("");
  modal2("<div class='dlg-head'>Register New Client<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    "<label>Full name</label><input type='text' id='r-name'><label>Address</label><input type='text' id='r-addr'>" +
    "<div class='two'><div><label>Mobile no.</label><input type='text' id='r-mobile' maxlength='11' placeholder='09XXXXXXXXX'></div><div><label>Email address</label><input type='text' id='r-email'></div></div>" +
    "<div class='two'><div><label>Branch</label><select id='r-branch'>" + opts + "</select></div><div><label>Plan</label><select id='r-plan'>" + PLANS.map(function (p) { return "<option>" + p.n + "</option>"; }).join("") + "</select></div></div>" +
    "<label>Device location</label><input type='text' id='r-device' placeholder='e.g. Router on the shelf next to the front door'><label>Installation date</label><input type='date' id='r-date' max='2026-10-24'>" +
    "<p class='muted'>Account No. is built automatically: Branch Code + Year Registered + 4-digit Client ID (8 digits).</p><p class='error' id='r-err'></p>" +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>Cancel</button><button class='btn' onclick='saveClient()'>Register</button></div></div>");
  if (!isAdmin() && STAFF_BRANCH) { $("r-branch").value = STAFF_BRANCH; $("r-branch").disabled = true; }
}
function saveClient() {
  var v = function (id) { return $(id).value.trim(); };
  if (!v("r-name") || !v("r-addr") || !v("r-email") || !v("r-device") || !v("r-date")) { $("r-err").innerHTML = "Please fill in all fields."; return; }
  if (!/^09[0-9]{9}$/.test(v("r-mobile"))) { $("r-err").innerHTML = "Mobile no. must be 11 digits starting with 09."; return; }
  var br = branchOf(v("r-branch")), ids = clients.filter(function (c) { return c.branch == br.name; }).map(function (c) { return +c.no.slice(4); }), id = Math.max.apply(null, ids.concat([1000])) + 1;
  var plan = PLANS.filter(function (p) { return p.n == v("r-plan"); })[0], day = parseISO(v("r-date")).getDate(), no = br.code + v("r-date").slice(2, 4) + id;
  S.add.push({ no: no, name: v("r-name"), branch: br.name, short: br.short, status: "Active", plan: plan.n, rate: plan.r, contact: v("r-mobile"), email: v("r-email"), installed: v("r-date"), due: Math.min(day, 28), dueISO: monthDay("2026-10", Math.min(day, 28)), address: v("r-addr"), device: v("r-device"), fb: "fb.com/" + v("r-name").split(" ")[0].toLowerCase() + "." + id, bill: "Not Yet Sent", reason: null, flagged: null, graceEnd: null, termDate: null, termReason: null });
  saveState(); rebuild(); closeModal(); logActivity(br.name, "Registered new client " + v("r-name") + " (" + no + ")."); toast("Client registered. Account No.: " + no); renderClients();
  if (window.onClientsChanged) onClientsChanged();
}
