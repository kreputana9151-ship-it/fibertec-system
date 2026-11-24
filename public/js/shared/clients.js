/* FiberTec - Clients records (shared by Admin and Staff) + live API dialogs.
   Staff registers new clients (setting email & initial password) and views branch records.
   Only the Admin role may terminate or reactivate accounts. */
var CV = { tab: "All" }, TABS = ["All", "Active", "Grace Period", "Under Review", "Terminated"];
var STAFF_BRANCH = sessionStorage.getItem("fiberBranch");
var LIVE_STAFF_CLIENTS = [];
var LIVE_STAFF_LOADED = false;

function isAdmin() { return ROLE == "admin"; }

function safeFmtD(val, shortMode) {
  if (!val) return "—";
  var str = String(val).trim();
  if (!str || str === "null" || str === "undefined") return "—";
  return shortMode ? fmtD(str, shortMode) : fmtD(str);
}

function planIdForName(planName) {
  var p = String(planName || "").toLowerCase();
  if (p.indexOf("50") >= 0) return 1;
  if (p.indexOf("110") >= 0) return 2;
  if (p.indexOf("150") >= 0) return 3;
  if (p.indexOf("220") >= 0) return 4;
  return 1;
}

function getLiveBillingSummary(accountNo, fallbackRate) {
  var stmts = (typeof LIVE !== "undefined" && Array.isArray(LIVE.statements))
    ? LIVE.statements.filter(function (s) { return s.acc === accountNo; })
    : [];
  var pays = (typeof LIVE !== "undefined" && Array.isArray(LIVE.payments))
    ? LIVE.payments.filter(function (p) { return p.acc === accountNo; })
    : [];

  if (!stmts.length) return null;

  stmts.sort(function (a, b) {
    return (b.month || b.due || "").localeCompare(a.month || a.due || "");
  });
  var latest = stmts[0];

  var totalBilled = 0;
  var totalPaidFromStmts = 0;
  stmts.forEach(function (s) {
    totalBilled += Number(s.amount || 0);
    totalPaidFromStmts += Number(s.paid || 0);
  });

  var totalVerifiedPays = 0;
  var hasPending = false;
  pays.forEach(function (p) {
    if (p.status === "Verified") totalVerifiedPays += Number(p.amount || 0);
    if (p.status === "Pending") hasPending = true;
  });

  var effectivePaid = Math.max(totalPaidFromStmts, totalVerifiedPays);
  var balance = Math.max(0, totalBilled - effectivePaid);
  var latestBalance = Math.max(0, Number(latest.amount || 0) - Number(latest.paid || 0));

  var payStatus = "Paid";
  if (balance > 0 && latestBalance > 0) {
    payStatus = hasPending ? "Pending" : (effectivePaid > 0 && latest.paid > 0 ? "Partial" : "Unpaid");
  }

  return {
    latest: latest,
    dueISO: latest.due || "",
    pay: payStatus,
    balance: balance
  };
}

function getAllActiveClients() {
  if (isAdmin() && typeof LIVE !== "undefined" && LIVE.loaded && Array.isArray(LIVE.clients)) {
    return LIVE.clients.map(function (c) {
      var base = (typeof clientByNo === "function" ? clientByNo(c.no) : null) || {};
      var liveBill = getLiveBillingSummary(c.no, c.rate);

      var graceEnd = c.grace_end_date || base.graceEnd || "";
      var graceLeft = base.graceLeft || 0;
      if (graceEnd) {
        var diffMs = new Date(String(graceEnd).slice(0, 10) + "T23:59:59+08:00") - new Date();
        graceLeft = Math.max(0, Math.ceil(diffMs / 86400000));
      }
      var balance = c.status === "Terminated" && c.outstanding_balance != null
        ? Number(c.outstanding_balance)
        : (liveBill ? liveBill.balance : 0);

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
        dueISO: liveBill ? liveBill.dueISO : "",
        pay: c.status === "Terminated" && c.outstanding_balance != null
          ? (balance <= 0 ? "Paid" : "Unpaid")
          : (liveBill ? liveBill.pay : "Paid"),
        balance: balance,
        graceEnd: graceEnd,
        graceLeft: graceLeft,
        reason: c.status_reason || base.reason || "Overdue Balance",
        flagged: c.flagged_date || base.flagged || "",
        termDate: c.termination_date ? String(c.termination_date).slice(0, 10) : "",
        termReason: c.termination_reason || c.status_reason || base.termReason || "Terminated",
        installed: c.registered_date ? String(c.registered_date).slice(0, 10) : "",
        address: c.address || base.address || "",
        fb: c.facebook || "",
        device: c.router_location || ""
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
      var graceEnd = r.grace_end_date || base.graceEnd || "";
      var graceLeft = base.graceLeft || 0;
      if (graceEnd) {
        var diffMs = new Date(String(graceEnd).slice(0, 10) + "T23:59:59+08:00") - new Date();
        graceLeft = Math.max(0, Math.ceil(diffMs / 86400000));
      }
      var outstanding = r.outstanding_balance != null ? Number(r.outstanding_balance) : Number(base.balance || 0);
      return Object.assign({}, base, {
        no: r.account_no,
        name: r.name,
        contact: r.contact_no || base.contact || "",
        email: r.email || base.email || "",
        branch: STAFF_BRANCH || base.branch || "",
        plan: r.plan_name || base.plan || "LiteSpeed 50Mbps",
        rate: Number(r.monthly_rate || base.rate || 0),
        balance: r.status === "Terminated" ? outstanding : (r.current_balance != null ? Number(r.current_balance) : Number(base.balance || 0)),
        status: r.status || "Active",
        due: Number(r.due_day || base.due || 15),
        dueISO: base.dueISO || "",
        pay: r.status === "Terminated"
          ? (outstanding <= 0 ? "Paid" : "Unpaid")
          : (base.pay || "Paid"),
        graceEnd: graceEnd,
        graceLeft: graceLeft,
        reason: r.status_reason || base.reason || "Client Cancellation Request",
        flagged: r.flagged_date || base.flagged || "",
        termDate: r.termination_date ? String(r.termination_date).slice(0, 10) : "",
        termReason: r.termination_reason || r.status_reason || base.termReason || "",
        installed: r.registered_date ? String(r.registered_date).slice(0, 10) : "",
        address: r.address || base.address || "",
        fb: r.facebook || "",
        device: r.router_location || ""
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
    "Active": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Branch", function (c) { return esc(c.branch); }], ["Internet Plan", function (c) { return esc(c.plan); }], ["Monthly Rate", function (c) { return peso(c.rate); }], ["Due Date", function (c) { return c.dueISO ? safeFmtD(c.dueISO, 1) : ("Every " + ordinal(c.due || 15)); }], ["Payment Status", function (c) { return badgeFor(c.pay || "Paid"); }]],
    "Grace Period": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Monthly Rate", function (c) { return peso(c.rate); }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Grace Period Ends", function (c) { return safeFmtD(c.graceEnd); }], ["Days Remaining", function (c) { return "<b>" + c.graceLeft + " Day" + (c.graceLeft == 1 ? "" : "s") + " Left</b>"; }]],
    "Under Review": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Branch", function (c) { return esc(c.branch); }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Reason", function (c) { return esc(c.reason); }], ["Date Flagged", function (c) { return safeFmtD(c.flagged); }]],
    "Terminated": [["Account No.", function (c) { return c.no; }], ["Client Name", function (c) { return esc(c.name); }], ["Internet Plan", function (c) { return esc(c.plan); }], ["Outstanding Balance", function (c) { return peso(c.balance); }], ["Termination Date", function (c) { return safeFmtD(c.termDate); }], ["Payment Status", function (c) { return badgeFor(c.pay || "Unpaid"); }]]
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

/* ---------- Direct PDF Export (Admin & Staff) ---------- */
function pdfEscapeText(str) {
  return String(str == null ? "" : str)
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function downloadTablePDF(filename, title, subtitle, headers, rows) {
  var pageW = 792, pageH = 612; // Landscape Letter (11 x 8.5 in)
  var marginX = 36, startY = 530, rowH = 20, maxRowsPerPage = 21;
  var usableW = pageW - marginX * 2;
  var colW = usableW / headers.length;

  var chunks = [];
  if (!rows.length) {
    chunks.push([]);
  } else {
    for (var i = 0; i < rows.length; i += maxRowsPerPage) {
      chunks.push(rows.slice(i, i + maxRowsPerPage));
    }
  }

  var objects = [];
  function addObj(body) {
    objects.push(body);
    return objects.length;
  }

  var catalogId = addObj("");
  var pagesId = addObj("");
  var fontRegId = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  var fontBoldId = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  var pageIds = [];
  chunks.forEach(function (pageRows, pageIdx) {
    var ops = [];

    // Header banner
    ops.push("0 0.255 0.486 rg");
    ops.push(marginX + " 552 " + usableW + " 34 re f");
    ops.push("1 1 1 rg");
    ops.push("BT /F2 13 Tf " + (marginX + 12) + " 565 Td (" + pdfEscapeText("FiberTec IT Solutions - " + title) + ") Tj ET");
    ops.push("BT /F1 9 Tf " + (pageW - marginX - 110) + " 566 Td (" + pdfEscapeText("Page " + (pageIdx + 1) + " of " + chunks.length) + ") Tj ET");

    // Subtitle & timestamp
    ops.push("0.25 0.32 0.42 rg");
    ops.push("BT /F1 9 Tf " + marginX + " 538 Td (" + pdfEscapeText(subtitle + "  |  Generated: " + new Date().toLocaleString()) + ") Tj ET");

    // Table header row
    var y = startY - 18;
    ops.push("0.91 0.94 0.98 rg");
    ops.push(marginX + " " + (y - 5) + " " + usableW + " " + rowH + " re f");
    ops.push("0 0.18 0.43 rg");
    headers.forEach(function (h, cIdx) {
      var x = marginX + cIdx * colW + 4;
      var maxChars = Math.max(8, Math.floor((colW - 8) / 5.2));
      ops.push("BT /F2 8.5 Tf " + x.toFixed(1) + " " + (y + 2) + " Td (" + pdfEscapeText(String(h).slice(0, maxChars)) + ") Tj ET");
    });

    // Table rows
    if (!pageRows.length) {
      y -= rowH;
      ops.push("0.4 0.4 0.4 rg");
      ops.push("BT /F1 9 Tf " + (marginX + 6) + " " + (y + 2) + " Td (No records match the current filter.) Tj ET");
    } else {
      pageRows.forEach(function (r, rIdx) {
        y -= rowH;
        if (rIdx % 2 === 1) {
          ops.push("0.97 0.98 0.99 rg");
          ops.push(marginX + " " + (y - 5) + " " + usableW + " " + rowH + " re f");
        }
        ops.push("0.85 0.88 0.92 RG 0.5 w");
        ops.push(marginX + " " + (y - 5) + " m " + (marginX + usableW) + " " + (y - 5) + " l S");

        ops.push("0.1 0.12 0.16 rg");
        r.forEach(function (cell, cIdx) {
          var x = marginX + cIdx * colW + 4;
          var maxChars = Math.max(8, Math.floor((colW - 8) / 5.0));
          var txt = String(cell == null ? "—" : cell).slice(0, maxChars);
          ops.push("BT /F1 8 Tf " + x.toFixed(1) + " " + (y + 2) + " Td (" + pdfEscapeText(txt) + ") Tj ET");
        });
      });
    }

    var streamData = ops.join("\n");
    var contentId = addObj("<< /Length " + streamData.length + " >>\nstream\n" + streamData + "\nendstream");
    var pageId = addObj(
      "<< /Type /Page /Parent " + pagesId + " 0 R " +
      "/MediaBox [0 0 " + pageW + " " + pageH + "] " +
      "/Resources << /Font << /F1 " + fontRegId + " 0 R /F2 " + fontBoldId + " 0 R >> >> " +
      "/Contents " + contentId + " 0 R >>"
    );
    pageIds.push(pageId);
  });

  objects[catalogId - 1] = "<< /Type /Catalog /Pages " + pagesId + " 0 R >>";
  objects[pagesId - 1] = "<< /Type /Pages /Kids [" + pageIds.map(function (id) { return id + " 0 R"; }).join(" ") + "] /Count " + pageIds.length + " >>";

  var pdf = "%PDF-1.4\n";
  var offsets = [0];
  for (var idx = 0; idx < objects.length; idx++) {
    offsets.push(pdf.length);
    pdf += (idx + 1) + " 0 obj\n" + objects[idx] + "\nendobj\n";
  }
  var xrefStart = pdf.length;
  pdf += "xref\n0 " + (objects.length + 1) + "\n";
  pdf += "0000000000 65535 f \n";
  for (var k = 1; k < offsets.length; k++) {
    pdf += String(offsets[k]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += "trailer\n<< /Size " + (objects.length + 1) + " /Root " + catalogId + " 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF";

  var blob = new Blob([pdf], { type: "application/pdf" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

function exportClients() {
  var rows = clientFilters(false);
  var scope = isAdmin() ? (val("f-branch") || "All Branches") : (STAFF_BRANCH || "Branch");
  var headers = ["Account No.", "Client Name", "Contact No.", "Email", "Branch", "Plan", "Status"];
  var data = rows.map(function (c) {
    return [c.no, c.name, c.contact || "—", c.email || "—", c.branch, c.plan, c.status];
  });
  downloadTablePDF(
    "fibertec-clients.pdf",
    "Subscriber Directory (" + scope + ")",
    "Filter: " + CV.tab + "  |  Total Subscribers: " + rows.length,
    headers,
    data
  );
  toast("Exported " + rows.length + " clients to PDF.");
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
  var liveBill = getLiveBillingSummary(no, c.rate);
  var deviceLocation = String(c.device || "").trim() || "Standard indoor ONT placement";
  var s = liveBill && liveBill.latest
    ? { inv: liveBill.latest.inv || "—", bill: liveBill.latest.bill || c.installed || "", due: liveBill.latest.due || "", paid: liveBill.latest.paid || 0, amount: liveBill.latest.amount || c.rate || 0 }
    : { inv: "—", bill: c.installed || "", due: c.dueISO || "", paid: 0, amount: c.rate || 0 };
  var extra = "";
  if (c.status == "Under Review") extra = "<div class='cd-note'><div class='warn amber'><b>Under Review</b> &middot; " + esc(c.reason) + (c.flagged ? " &middot; flagged " + safeFmtD(c.flagged) : "") + (isAdmin() ? "" : ". Waiting for an administrator's decision.") + "</div></div>";
  if (c.status == "Terminated") extra = "<div class='cd-note'><div class='warn red'><b>Terminated</b>" + (c.termDate ? " on " + safeFmtD(c.termDate) : "") + " &middot; " + esc(c.termReason || "Non-Payment") + "</div></div>";
  if (c.status == "Grace Period") extra = "<div class='cd-note'><div class='warn amber'><b>Grace period</b>" + (c.graceEnd ? " ends " + safeFmtD(c.graceEnd) : "") + " (" + c.graceLeft + " day" + (c.graceLeft == 1 ? "" : "s") + " left)</div></div>";
  modal2("<div class='cd-hero'><span class='avatar'>" + initials(c.name) + "</span><div><h2>" + esc(c.name) + "</h2><small>Account " + c.no + " &middot; " + esc(c.branch) + " Branch</small><div style='margin-top:8px'>" + badgeFor(c.status) + "</div></div>" +
    (isAdmin() ? "<button class='btn btn-light' onclick='editClient(\"" + c.no + "\")'>Edit Client</button>" : "") +
    "<button class='x dlg-x' style='background:none;border:0;color:#fff;font-size:28px;cursor:pointer' onclick='closeModal()'>&times;</button></div>" +
    "<div class='cd-stats'><div class='cd-stat'><small>Plan</small><b>" + esc(c.plan.replace(/\s*Mbps/, " Mbps")) + "</b></div><div class='cd-stat'><small>Monthly rate</small><b>" + peso(c.rate) + "</b></div><div class='cd-stat'><small>Payment status</small><b>" + esc(c.pay || "Paid") + "</b></div><div class='cd-stat'><small>Balance</small><b>" + peso(c.balance || 0) + "</b></div></div>" + (extra ? "<div style='height:14px'></div>" + extra : "") +
    "<div class='cd-grid'><div class='cd-sec'><h4>Records</h4>" + kv("Branch", esc(c.branch) + " Branch") + kv("Plan", "FiberTec " + esc(c.plan)) + kv("Installed date", safeFmtD(c.installed)) + kv("Monthly rate", peso(c.rate)) + kv("Payment due date", "Every " + ordinal(c.due || 15)) + "</div>" +
    "<div class='cd-sec'><h4>Address and contact</h4>" + kv("Address", esc(c.address || "—")) + kv("Contact no.", esc(c.contact || "—")) + kv("Email", esc(c.email || "—")) + kv("FB / Messenger", esc(c.fb || "—")) + "</div>" +
    "<div class='cd-sec'><h4>Current statement</h4>" + kv("Invoice no.", esc(s.inv)) + kv("Billing date", safeFmtD(s.bill)) + kv("Due date", safeFmtD(s.due)) + kv("Paid / due", peso(s.paid) + " / " + peso(s.amount)) + "</div>" +
    "<div class='cd-sec'><h4>Connection device location</h4><p style='margin:6px 0 0'>" + esc(deviceLocation) + "</p></div></div>" +
    (isAdmin() ? "" : "<div class='cd-note' style='padding-bottom:18px'><div class='view-only' style='margin:0'>Staff can approve or reject client cancellation requests. Only Administrators can reactivate terminated accounts.</div></div>"), "");
}

/* ---------- Admin actions (Live Neon DB API) ---------- */
function denyIfNotAdmin() { if (isAdmin()) return false; toast("Permission denied: only administrators can do this.", "error"); return true; }

function editClient(no) {
  if (denyIfNotAdmin()) return;
  var c = findClientRecord(no);
  if (!c) { toast("Client record not found.", "error"); return; }
  var plans = PLANS.map(function (p, i) {
    var id = i + 1;
    return "<option value='" + id + "'" + (id == (c.plan_id || planIdForName(c.plan)) ? " selected" : "") + ">" + esc(p.n) + "</option>";
  }).join("");
  modal2("<div class='dlg-head'>Edit Client<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    "<label>Full name</label><input id='e-name' maxlength='100' value='" + esc(c.name) + "'>" +
    "<label>Address</label><input id='e-address' maxlength='255' value='" + esc(c.address || "") + "'>" +
    "<div class='two'><div><label>Mobile no.</label><input id='e-contact' maxlength='15' value='" + esc(c.contact || "") + "'></div>" +
    "<div><label>Client Email</label><input id='e-email' type='email' maxlength='100' value='" + esc(c.email || "") + "'></div></div>" +
    "<div class='two'><div><label>Internet Plan</label><select id='e-plan'>" + plans + "</select></div>" +
    "<div><label>FB / Messenger (optional)</label><input id='e-facebook' maxlength='100' value='" + esc(c.fb || "") + "'></div></div>" +
    "<label>Connection device location (optional)</label><input id='e-device' maxlength='150' value='" + esc(c.device || "") + "'>" +
    "<p class='error' id='e-error'></p><div class='dlg-foot'><button class='btn btn-light' onclick='closeModal()'>Cancel</button>" +
    "<button class='btn' onclick='saveClientEdit(\"" + c.no + "\")'>Save Changes</button></div></div>");
}

async function saveClientEdit(no) {
  var name = $("e-name").value.trim();
  var address = $("e-address").value.trim();
  var contactNo = $("e-contact").value.trim();
  var email = $("e-email").value.toLowerCase();
  var facebook = $("e-facebook").value.trim();
  var routerLocation = $("e-device").value.trim();
  var planId = Number($("e-plan").value);
  var err = $("e-error");
  err.innerHTML = "";

  if (!name || !address || !contactNo || !email) {
    err.innerHTML = "Please complete the client name, address, contact number, and email.";
    return;
  }
  if (/\s/.test(email)) {
    err.innerHTML = "Client email must not contain whitespace.";
    return;
  }
  if (!/^09[0-9]{9}$/.test(contactNo)) {
    err.innerHTML = "Mobile no. must be 11 digits starting with 09.";
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    err.innerHTML = "Please enter a valid email address.";
    return;
  }

  try {
    await adminApi("/clients/" + encodeURIComponent(no), {
      method: "PATCH",
      body: JSON.stringify({ name: name, address: address, contactNo: contactNo, email: email, planId: planId, facebook: facebook, routerLocation: routerLocation })
    });
  } catch (e) {
    err.innerHTML = esc(e.message || "Could not update client details.");
    return;
  }

  closeModal();
  try {
    await syncAdminData();
  } catch (e) {
    renderClients();
    toast("Client details were saved, but the refreshed record could not be loaded: " + e.message, "error");
    return;
  }
  renderClients();
  viewClient(no);
  toast("Client details updated.");
}

function reviewClient(no) {
  if (denyIfNotAdmin()) return;
  var c = findClientRecord(no), cancel = c.reason == "Client Cancellation Request";
  modal2("<div class='dlg-head'>Under Review &middot; Take Action<button class='x' onclick='closeModal()'>&times;</button></div><div class='dlg-body'>" +
    kv("Client", esc(c.name)) + kv("Account No.", c.no) + kv("Branch", esc(c.branch)) + kv("Outstanding Balance", peso(c.balance)) + kv("Reason", esc(c.reason)) + kv("Date flagged", safeFmtD(c.flagged)) +
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
  var today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
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
    "<label>FB / Messenger (optional)</label><input type='text' id='r-facebook' maxlength='100'>" +
    "<label>Device location</label><input type='text' id='r-device' maxlength='150' placeholder='e.g. Router on the shelf next to the front door'>" +
    "<p class='muted' style='margin-top:6px'>Account No. is generated automatically: Branch Code + Year + 4-digit Client ID. The client will sign in using this email or Account No. and password.</p>" +
    "<p class='error' id='r-err'></p>" +
    "<div class='dlg-foot'><button type='button' class='btn btn-light' onclick='closeModal()'>Cancel</button><button type='button' id='r-submit' class='btn' onclick='saveClient()'>Register Client</button></div></div>");
  if (!isAdmin() && STAFF_BRANCH) { $("r-branch").value = STAFF_BRANCH; $("r-branch").disabled = true; }
}

async function saveClient() {
  var v = function (id) { return $(id) ? $(id).value.trim() : ""; };
  var errEl = $("r-err"), btn = $("r-submit");
  errEl.innerHTML = "";

  var name = v("r-name"), addr = v("r-addr"), mobile = v("r-mobile"), email = $("r-email") ? $("r-email").value.toLowerCase() : "";
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
  if (/\s/.test(email)) {
    errEl.innerHTML = "Client email must not contain whitespace.";
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.innerHTML = "Please enter a valid email address.";
    return;
  }
  if (/\s/.test(pass)) {
    errEl.innerHTML = "Initial portal password must not contain whitespace.";
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
      facebook: v("r-facebook"),
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