/* FiberTec - Clients records (shared by Admin and Staff) + live API dialogs.
   Staff registers new clients (setting email & initial password) and views branch records.
   Only the Admin role may terminate or reactivate accounts. */
var CV = { tab: "All" }, TABS = ["All", "Active", "Grace Period", "Under Review", "Terminated"];
var STAFF_BRANCH = sessionStorage.getItem("fiberBranch");
var LIVE_STAFF_CLIENTS = [];
var LIVE_STAFF_LOADED = false;

function isAdmin() { return ROLE == "admin"; }

function planIdForName(planName) {
  var p = String(planName || "").toLowerCase();
  if (p.indexOf("50") >= 0) return 1;
  if (p.indexOf("110") >= 0) return 2;
  if (p.indexOf("150") >= 0) return 3;
  if (p.indexOf("220") >= 0) return 4;
  return 1;
}

function getAllActiveClients() {
  if (isAdmin() && typeof LIVE !== "undefined" && LIVE.loaded && Array.isArray(LIVE.clients)) {
    return LIVE.clients.map(function (c) {
      var base = (typeof clientByNo === "function" ? clientByNo(c.no) : null) || {};
      return Object.assign({}, base, {
        no: c.no,
        name: c.name,
        contact: c.contact || base.contact || "",
        email: c.email || base.email || "",
        branch: c.branch,
        plan: c.plan || base.plan || "LiteSpeed 50Mbps",
        rate: Number(c.rate || base.rate || 0),
        status: c.status,
        due: Number(c.due_day || base.due || 15),
        dueISO: base.dueISO || "",
        pay: base.pay || "Paid",
        balance: Number(base.balance || 0),
        graceEnd: base.graceEnd || "",
        graceLeft: base.graceLeft || 0,
        reason: base.reason || "Client Cancellation Request",
        flagged: base.flagged || "",
        termDate: c.terminated_month ? c.terminated_month + "-01" : (base.termDate || ""),
        termReason: base.termReason || "Terminated",
        installed: c.created_month ? c.created_month + "-01" : (base.installed || ""),
        address: c.address || base.address || "",
        fb: base.fb || "",
        device: base.device || ""
      });
    });
  }

  if (!isAdmin() && LIVE_STAFF_LOADED) {
    return LIVE_STAFF_CLIENTS;
  }

  return typeof clients !== "undefined" ? clients : [];
}

async function syncStaffClients() {
  if (isAdmin()) return;
  try {
    var rows = await apiCall("GET", "/api/staff/clients");
    LIVE_STAFF_CLIENTS = rows.map(function (r) {
      var base = (typeof clientByNo === "function" ? clientByNo(r.account_no) : null) || {};
      return Object.assign({}, base, {
        no: r.account_no,
        name: r.name,
        contact: r.contact_no || base.contact || "",
        email: r.email || base.email || "",
        branch: STAFF_BRANCH || base.branch || "",
        plan: r.plan_name || base.plan || "LiteSpeed 50Mbps",
        rate: Number(r.monthly_rate || base.rate || 0),
        status: r.status || "Active",
        due: Number(r.due_day || base.due || 15),
        dueISO: base.dueISO || "",
        pay: base.pay || "Paid",
        balance: Number(base.balance || 0),
        graceEnd: base.graceEnd || "",
        graceLeft: base.graceLeft || 0,
        reason: base.reason || "Client Cancellation Request",
        flagged: base.flagged || "",
        termDate: base.termDate || "",
        termReason: base.termReason || "",
        installed: r.registered_date || base.installed || "",
        address: r.address || base.address || "",
        fb: base.fb || "",
        device: base.device || ""
      });
    });
    LIVE_STAFF_LOADED = true;
  } catch (e) {
    if (e && e.status != 401) {
      toast((e && e.message) || "Could not refresh branch clients.", "error");
    }
  }
}

async function initClientsView() {
  fillSelect("f-branch", "All Branches", branchNames());
  fillSelect("f-plan", "All Plans", planNames());
  if (!isAdmin() && STAFF_BRANCH) {
    $("f-branch").value = STAFF_BRANCH;
    $("f-branch").disabled = true;
    $("f-branch").title = "Staff can only see their own branch";
    await syncStaffClients();
  }
  renderClients();
}

function clientFilters(skipStatus) {
  var q = val("search").trim().toLowerCase(), b = val("f-branch"), p = val("f-plan");
  return getAllActiveClients().filter(function (c) {
    if (!isAdmin() && STAFF_BRANCH && c.branch != STAFF_BRANCH) return false;
    if (b && c.branch != b) return false;
    if (p && c.plan != p) return false;
    if (!skipStatus && CV.tab != "All" && c.status != CV.tab) return false;
    if (q && (c.no + " " + c.name + " " + (c.email || "")).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

function onClientFilter() { pgReset("clients"); renderClients(); }
function setClientTab(t) { CV.tab = t; pgReset("clients"); renderClients(); }

function clientCols(tab) {
  var act = isAdmin(), take = function (c) { return "<button class='action review' onclick='event.stopPropagation();reviewClient(\"" + c.no + "\")'>Take Action</button>"; };
  var cols = {
    "All": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Contact No.", function (c) { return esc(c.contact || "—"); }], ["Email", function (c) { return esc(c.email || "—"); }], ["Branch", function (c) { return esc(c.branch); }], ["Internet Plan", function (c) { return esc(c.plan); }], ["Status", function (c) { return badgeFor(c.status); }]],
    "Active": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Branch", function (c) { return esc(c.branch); }], ["Internet Plan", function (c) { return esc(c.plan); }], ["Monthly Rate", function (c) { return peso(c.rate); }], ["Due Date", function (c) { return c.dueISO ? fmtD(c.dueISO, 1) : ("Every " + ordinal(c.due || 15)); }], ["Payment Status", function (c) { return badgeFor(c.pay || "Paid"); }]],
    "Grace Period": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Monthly Rate", function (c) { return peso(c.rate); }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Grace Period Ends", function (c) { return fmtD(c.graceEnd); }], ["Days Remaining", function (c) { return "<b>" + c.graceLeft + " Day" + (c.graceLeft == 1 ? "" : "s") + " Left</b>"; }]],
    "Under Review": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Branch", function (c) { return esc(c.branch); }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Reason", function (c) { return esc(c.reason); }], ["Date Flagged", function (c) { return fmtD(c.flagged); }]],
    "Terminated": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Internet Plan", function (c) { return esc(c.plan); }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Termination Date", function (c) { return fmtD(c.termDate); }], ["Payment Status", function (c) { return badgeFor(c.pay || "Unpaid"); }]]
  }[tab];
  if (act && tab == "Under Review") cols.push(["Action", take]);
  if (act && tab == "Terminated") cols.push(["Action", function (c) { return "<button class='action' onclick='event.stopPropagation();reactivate(\"" + c.no + "\")'>Take Action</button>"; }]);
  return cols;
}

function renderClients() {
  var base = clientFilters(true), t = "";
  TABS.forEach(function (tb) {
    var n = base.filter(function (c) { return tb == "All" || c.status == tb; }).length;
    t += "<button class='" + (tb == CV.tab ? "active" : "") + "' onclick='setClientTab(\"" + tb + "\")'>" + tb + "<em>" + n + "</em></button>";
  });
  $("client-tabs").innerHTML = t;
  var rows = clientFilters(false), info = paginate("clients", rows), cols = clientCols(CV.tab), s = "<thead><tr>";
  cols.forEach(function (c) { s += "<th>" + c[0] + "</th>"; });
  s += "</tr></thead><tbody>";
  info.rows.forEach(function (c) {
    s += "<tr class='click' onclick='viewClient(\"" + c.no + "\")'>";
    cols.forEach(function (k) { s += "<td>" + k[1](c) + "</td>"; });
    s += "</tr>";
  });
  if (!rows.length) s += emptyRow(cols.length);
  $("client-table").innerHTML = s + "</tbody>";
  $("client-foot").innerHTML = footHTML("clients", info, renderClients);
}

function exportClients() {
  var rows = clientFilters(false);
  downloadCSV("fibertec-clients.csv", [["Account No.", "Client Name", "Contact No.", "Email", "Branch", "Plan", "Status", "Payment Status"]].concat(rows.map(function (c) {
    return [c.no, c.name, c.contact, c.email, c.branch, c.plan, c.status, c.pay];
  })));
  toast("Exported " + rows.length + " clients to CSV.");
}

/* ---------- View details (read-only; used by both portals) ---------- */
function findClientRecord(no) {
  var liveMatch = getAllActiveClients().filter(function (c) { return c.no == no; })[0];
  if (liveMatch) return liveMatch;
  return typeof clientByNo === "function" ? clientByNo(no) : null;
}

function viewClient(no) {
  var c = findClientRecord(no);
  if (!c) { toast("Client record not found.", "error"); return; }
  var s = (typeof statement === "function" && typeof clientByNo === "function" && clientByNo(no))
    ? statement(clientByNo(no), "2026-10")
    : { inv: "—", bill: c.installed || "", due: c.dueISO || "", paid: 0, amount: c.rate || 0 };
  var extra = "";
  if (c.status == "Under Review") extra = "<div class='cd-note'><div class='warn amber'><b>Under Review</b> &middot; " + esc(c.reason) + " &middot; flagged " + fmtD(c.flagged) + (isAdmin() ? "" : ". Waiting for an administrator's decision.") + "</div></div>";
  if (c.status == "Terminated") extra = "<div class='cd-note'><div class='warn red'><b>Terminated</b> on " + fmtD(c.termDate) + " &middot; " + esc(c.termReason || "Non-Payment") + "</div></div>";
  if (c.status == "Grace Period") extra = "<div class='cd-note'><div class='warn amber'><b>Grace period</b> ends " + fmtD(c.graceEnd) + " (" + c.graceLeft + " day" + (c.graceLeft == 1 ? "" : "s") + " left)</div></div>";
  modal2("<div class='cd-hero'><span class='avatar'>" + initials(c.name) + "</span><div><h2>" + esc(c.name) + "</h2><small>Account " + c.no + " &middot; " + esc(c.branch) + " Branch</small><div style='margin-top:8px'>" + badgeFor(c.status) + "</div></div><button class='x dlg-x' style='background:none;border:0;color:#fff;font-size:28px;cursor:pointer' onclick='closeModal()'>&times;</button></div>" +
    "<div class='cd-stats'><div class='cd-stat'><small>Plan</small><b>" + esc(c.plan.replace(/\s*Mbps/, " Mbps")) + "</b></div><div class='cd-stat'><small>Monthly rate</small><b>" + peso(c.rate) + "</b></div><div class='cd-stat'><small>Payment status</small><b>" + esc(c.pay || "Paid") + "</b></div><div class='cd-stat'><small>Balance</small><b>" + peso(c.balance || 0) + "</b></div></div>" + (extra ? "<div style='height:14px'></div>" + extra : "") +
    "<div class='cd-grid'><div class='cd-sec'><h4>Records</h4>" + kv("Branch", esc(c.branch) + " Branch") + kv("Plan", "FiberTec " + esc(c.plan)) + kv("Installed date", fmtD(c.installed)) + kv("Monthly rate", peso(c.rate)) + kv("Payment due date", "Every " + ordinal(c.due || 15)) + "</div>" +
    "<div class='cd-sec'><h4>Address and contact</h4>" + kv("Address", esc(c.address || "—")) + kv("Contact no.", esc(c.contact || "—")) + kv("Email", esc(c.email || "—")) + kv("FB / Messenger", esc(c.fb || "—")) + "</div>" +
    "<div class='cd-sec'><h4>Current statement</h4>" + kv("Invoice no.", esc(s.inv)) + kv("Billing date", fmtD(s.bill)) + kv("Due date", fmtD(s.due)) + kv("Paid / due", peso(s.paid) + " / " + peso(s.amount)) + "</div>" +
    "<div class='cd-sec'><h4>Connection device location</h4><p style='margin:6px 0 0'>" + esc(c.device || "Standard indoor ONT placement") + "</p></div></div>" +
    (isAdmin() ? "" : "<div class='cd-note' style='padding-bottom:18px'><div class='view-only' style='margin:0'>View only. Only administrators can terminate or reactivate accounts.</div></div>"), "");
}

/* ---------- Admin actions (Live Neon DB API) ---------- */
function denyIfNotAdmin() { if (isAdmin()) return false; toast("Permission denied: only administrators can do this.", "error"); return true; }

function reviewClient(no) {
  if (denyIfNotAdmin()) return;
  var c = findClientRecord(no), cancel = c.reason == "Client Cancellation Request";
  modal2("<div class='dlg-head'>Under Review &middot; Take Action<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    kv("Client", esc(c.name)) + kv("Account No.", c.no) + kv("Branch", esc(c.branch)) + kv("Outstanding Balance", peso(c.balance)) + kv("Reason", esc(c.reason)) + kv("Date flagged", fmtD(c.flagged)) +
    (cancel ? "<div class='warn blue'>The client asked to cancel this plan and branch staff approved the request. Terminate the account to finish the cancellation.</div>"
      : "<div class='warn amber'>Mark paid only after the settlement is verified. If no decision is made within 3 days, the account is terminated automatically.</div>") +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>Cancel</button>" + (cancel ? "" : "<button class='btn btn-green' onclick='markPaid(\"" + no + "\")'>Mark Paid</button>") + "<button class='btn btn-red' onclick='askTerminate(\"" + no + "\")'>Terminate</button></div></div>", "sm");
}

function askTerminate(no) {
  if (denyIfNotAdmin()) return;
  var c = findClientRecord(no);
  confirmBox("Terminate account", "Are you sure you want to terminate <b>" + esc(c.name) + "</b> (" + c.no + ")? The account moves to the Terminated tab.", "Yes, terminate", function () { terminateClient(no); }, true);
}

async function terminateClient(no) {
  if (denyIfNotAdmin()) return;
  var c = findClientRecord(no);
  try {
    await adminApi("/clients/" + encodeURIComponent(no) + "/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "Terminated", reason: c.reason || "Admin decision" })
    });
    closeModal();
    if (typeof syncAdminData === "function") await syncAdminData();
    renderClients();
    toast(c.name + " (" + no + ") has been terminated.");
  } catch (e) {
    toast(e.message || "Could not terminate account.", "error");
  }
}

async function markPaid(no) {
  if (denyIfNotAdmin()) return;
  var c = findClientRecord(no);
  try {
    await adminApi("/clients/" + encodeURIComponent(no) + "/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "Active", reason: "Reinstated by admin" })
    });
    closeModal();
    if (typeof syncAdminData === "function") await syncAdminData();
    renderClients();
    toast(c.name + " is marked active again.");
  } catch (e) {
    toast(e.message || "Could not update status.", "error");
  }
}

function reactivate(no) {
  if (denyIfNotAdmin()) return;
  var c = findClientRecord(no), blocked = c.pay == "Unpaid" || c.pay == "Pending";
  modal2("<div class='dlg-head'>&#8635; Reactivate Client Account<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    "<p class='muted'>Review the client's payment and account status before reactivation.</p>" + kv("Client", esc(c.name) + " (" + c.no + ")") + kv("Termination Reason", esc(c.termReason || "Non-Payment")) + kv("Outstanding Balance", peso(c.balance)) + kv("Payment Status", badgeFor(c.pay)) +
    (blocked ? "<div class='warn amber' id='re-warn'><b>Cannot reactivate yet.</b> Payment status is <b>" + c.pay + "</b>. The account can only be reactivated once the payment is verified (status Paid).</div>" : "<div class='warn blue'>Payment is settled. This account can be reactivated.</div>") +
    "<div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>Cancel</button><button class='btn btn-green " + (blocked ? "blocked" : "") + "' onclick='doReactivate(\"" + no + "\")'>Reactivate Account</button></div></div>", "sm");
}

async function doReactivate(no) {
  var c = findClientRecord(no);
  if (c.pay == "Unpaid" || c.pay == "Pending") {
    var w = $("re-warn");
    w.className = "warn red shake";
    w.innerHTML = "<b>Reactivation blocked.</b> You cannot reactivate an account while its payment status is " + c.pay + ". Ask branch staff to verify the payment first.";
    return;
  }
  try {
    await adminApi("/clients/" + encodeURIComponent(no) + "/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "Active", reason: "Reactivated by admin" })
    });
    closeModal();
    if (typeof syncAdminData === "function") await syncAdminData();
    renderClients();
    toast(c.name + " was reactivated.");
  } catch (e) {
    toast(e.message || "Could not reactivate account.", "error");
  }
}

/* ---------- Register a new client (Staff sets email & initial portal password) ---------- */
function toggleRegPw() {
  var inp = $("r-pass"), btn = $("r-pass-btn");
  if (!inp) return;
  var show = inp.type === "password";
  inp.type = show ? "text" : "password";
  if (btn) btn.textContent = show ? "Hide" : "Show";
}

function openRegister() {
  var today = new Date().toISOString().slice(0, 10);
  var opts = BRANCHES.map(function (b) { return "<option value='" + b.name + "'>" + b.code + " - " + b.name + "</option>"; }).join("");
  modal2("<div class='dlg-head'>Register New Client<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    "<label>Full name</label><input type='text' id='r-name' placeholder='e.g. Juan Dela Cruz'>" +
    "<label>Address</label><input type='text' id='r-addr' placeholder='Street, Barangay, Pasig City'>" +
    "<div class='two'>" +
      "<div><label>Mobile no.</label><input type='text' id='r-mobile' maxlength='11' placeholder='09XXXXXXXXX'></div>" +
      "<div><label>Client Email (Portal Login)</label><input type='email' id='r-email' placeholder='client@email.com'></div>" +
    "</div>" +
    "<div class='two'>" +
      "<div>" +
        "<label>Initial Portal Password</label>" +
        "<div style='display:flex;gap:6px;align-items:center'>" +
          "<input type='password' id='r-pass' minlength='8' maxlength='72' placeholder='Min. 8 characters' style='flex:1'>" +
          "<button type='button' id='r-pass-btn' class='btn btn-light' style='padding:8px 10px;white-space:nowrap' onclick='toggleRegPw()'>Show</button>" +
        "</div>" +
      "</div>" +
      "<div><label>Installation date</label><input type='date' id='r-date' value='" + today + "'></div>" +
    "</div>" +
    "<div class='two'>" +
      "<div><label>Branch</label><select id='r-branch'>" + opts + "</select></div>" +
      "<div><label>Plan</label><select id='r-plan'>" + PLANS.map(function (p) { return "<option value='" + p.n + "'>" + p.n + " (" + peso(p.r) + "/mo)</option>"; }).join("") + "</select></div>" +
    "</div>" +
    "<label>Device location</label><input type='text' id='r-device' placeholder='e.g. Router on the shelf next to the front door'>" +
    "<p class='muted' style='margin-top:6px'>Account No. is generated automatically: Branch Code + Year + 4-digit Client ID. The client will sign in using this email or Account No. and password.</p>" +
    "<p class='error' id='r-err'></p>" +
    "<div class='dlg-foot'><button type='button' class='btn btn-light' onclick='closeModal()'>Cancel</button><button type='button' id='r-submit' class='btn' onclick='saveClient()'>Register Client</button></div></div>");
  if (!isAdmin() && STAFF_BRANCH) { $("r-branch").value = STAFF_BRANCH; $("r-branch").disabled = true; }
}

async function saveClient() {
  var v = function (id) { return $(id) ? $(id).value.trim() : ""; };
  var errEl = $("r-err"), btn = $("r-submit");
  errEl.innerHTML = "";

  var name = v("r-name"), addr = v("r-addr"), mobile = v("r-mobile"), email = v("r-email").toLowerCase();
  var pass = $("r-pass") ? $("r-pass").value : "";
  var planName = v("r-plan"), device = v("r-device"), regDate = v("r-date");

  if (!name || !addr || !email || !pass || !device || !regDate) {
    errEl.innerHTML = "Please fill in all fields including client email and initial password.";
    return;
  }
  if (!/^09[0-9]{9}$/.test(mobile)) {
    errEl.innerHTML = "Mobile no. must be 11 digits starting with 09.";
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.innerHTML = "Please enter a valid email address.";
    return;
  }
  if (pass.length < 8 || pass.length > 72) {
    errEl.innerHTML = "Initial portal password must be between 8 and 72 characters.";
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "Registering..."; }

  try {
    var res = await apiCall("POST", "/api/staff/clients", {
      name: name,
      contactNo: mobile,
      email: email,
      password: pass,
      address: addr,
      planId: planIdForName(planName),
      routerLocation: device,
      registeredDate: regDate
    });

    await syncStaffClients();
    closeModal();
    renderClients();
    if (window.onClientsChanged) await window.onClientsChanged();

    modal2("<div class='dlg-head'>Client Registered Successfully<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
      "<div class='warn blue'>New subscriber account has been saved to the live database and portal credentials are active.</div>" +
      kv("Client Name", esc(name)) +
      kv("Account No.", "<b>" + esc(res.accountNo) + "</b>") +
      kv("Portal Email", esc(email)) +
      kv("Assigned Password", "<b>" + esc(pass) + "</b>") +
      kv("Internet Plan", esc(planName)) +
      "<p class='muted' style='margin-top:8px'>Share these login credentials with the client so they can access the Client Portal.</p>" +
      "<div class='dlg-foot'><button type='button' class='btn' onclick='closeModal()'>Done</button></div></div>", "sm");

    toast(res.message || ("Client registered. Account No.: " + res.accountNo));
  } catch (e) {
    errEl.innerHTML = esc((e && e.message) || "Could not register client. Please try again.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Register Client"; }
  }
}