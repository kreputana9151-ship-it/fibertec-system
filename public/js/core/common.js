var ROLE = sessionStorage.getItem("fiberRole");
function $(id) { return document.getElementById(id); }
function val(id) { var e = $(id); return e ? e.value : ""; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function peso(n) { return "&#8369;" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pesoPlain(n) { return "\u20B1" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function ordinal(n) { var v = n % 100; return n + (["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th"); }
function initials(n) { var p = n.split(" "); return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }
function fmtRef(r) { return /^[0-9]{13}$/.test(r) ? r.slice(0, 4) + " " + r.slice(4, 7) + " " + r.slice(7, 10) + " " + r.slice(10) : r; }
function badgeFor(s) {
  var c = { "Active": "green", "Paid": "green", "Verified": "green", "Delivered": "green", "Sent": "green", "Grace Period": "yellow", "Partially paid": "orange", "Pending": "orange", "Not Yet Sent": "orange", "Under Review": "orange", "Terminated": "red", "Unpaid": "red", "Failed": "red", "Rejected": "red" }[s] || "";
  return '<span class="badge ' + c + '">' + esc(s) + '</span>';
}
function fillSelect(id, first, items, keep) {
  var e = $(id); if (!e) return; var cur = e.value, h = first ? '<option value="">' + first + '</option>' : "";
  items.forEach(function (i) { var v = typeof i == "string" ? i : i.v, l = typeof i == "string" ? i : i.l; h += '<option value="' + esc(v) + '">' + esc(l) + '</option>'; });
  e.innerHTML = h; if (keep) e.value = cur;
}
function branchNames() { return BRANCHES.map(function (b) { return b.name; }); }
function planNames() { return PLANS.map(function (p) { return p.n; }); }
function monthItems() { return MONTHS.map(function (m) { return { v: m.k, l: m.l }; }); }

function api(path, body, token) {
  return fetch("/api/auth/" + path, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}), body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
}
function apiCall(method, path, body) {                                   // authenticated call to the backend
  var t = sessionStorage.getItem("fiberToken"), h = {};
  if (body) h["Content-Type"] = "application/json"; if (t) h.Authorization = "Bearer " + t;
  return fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (r.status == 401) { sessionStorage.clear(); location.replace("index.html"); throw { status: 401, message: "Session expired" }; }
      if (!r.ok) throw { status: r.status, message: d.error || "Request failed" };
      return d;
    });
  });
}
var LOGIN_RESULT = null, LOGIN_PW = "";
function goPortal(d, pw) {
  sessionStorage.setItem("fiberToken", d.token); sessionStorage.setItem("fiberRole", d.role);
  if (pw) sessionStorage.setItem("fiberPw", pw);
  if (d.role == "client") { sessionStorage.setItem("fiberAcc", d.accountNo); location.href = "client.html"; }
  else if (d.role == "staff") {
    var b = BRANCHES.filter(function (x) { return x.code == d.branchCode; })[0];
    sessionStorage.setItem("fiberBranch", b ? b.name : d.branchName); location.href = "staff.html";
  } else location.href = "admin.html";
}
function login() {
  var id = val("account").trim(), pw = val("password"), err = $("error");
  if (!id) { err.innerHTML = "Please enter your account number, email, or username."; return; }
  if (!pw) { err.innerHTML = "Please enter your password."; return; }
  err.innerHTML = "";
  api("login", { loginId: id, password: pw }).then(function (r) {
    if (!r.ok) { err.innerHTML = esc(r.data.error || "Login failed."); return; }
    if (r.data.mustChangePassword) { LOGIN_RESULT = r.data; LOGIN_PW = pw; $("login-form").classList.add("hidden"); $("cp-form").classList.remove("hidden"); return; }
    goPortal(r.data, pw);
  }).catch(function () { err.innerHTML = "Cannot reach the server. Please try again."; });
}
function changeFirstPassword() {
  var n = val("cp-new"), c = val("cp-confirm"), err = $("cp-error");
  if (n.length < 8) { err.innerHTML = "Password must be at least 8 characters."; return; }
  if (n != c) { err.innerHTML = "The two passwords do not match."; return; }
  api("change-password", { currentPassword: LOGIN_PW, newPassword: n }, LOGIN_RESULT.token).then(function (r) {
    if (!r.ok) { err.innerHTML = esc(r.data.error || "Could not save the password."); return; }
    goPortal(LOGIN_RESULT, n);
  }).catch(function () { err.innerHTML = "Cannot reach the server. Please try again."; });
}
function logout() { sessionStorage.clear(); location.href = "index.html"; }
function resetDemoData() { resetDemo(); $("error").innerHTML = ""; toast("Demo data was reset."); }
function requireRole(role) { if (sessionStorage.getItem("fiberRole") == role) return true; location.replace("index.html"); return false; }
function toggleSidebar() { $("layout").classList.toggle("collapsed"); }
function showSection(ids, id, prefix) {
  ids.forEach(function (i) { var e = $(i); if (e) e.classList.add("hidden"); var l = $(prefix + i); if (l) l.classList.remove("active"); });
  $(id).classList.remove("hidden"); $(id).classList.add("page"); var a = $(prefix + id); if (a) a.classList.add("active"); window.scrollTo(0, 0);
  resetFilters(id);
}
function resetFilters(id) {
  var sec = $(id); if (!sec) return;
  sec.querySelectorAll(".filters select, .dash-head select").forEach(function (s) { if (s.disabled && window.STAFF_BRANCH && s.id == "f-branch") s.value = STAFF_BRANCH; else s.selectedIndex = 0; });
  sec.querySelectorAll(".filters input.search").forEach(function (i) { i.value = ""; });
  PG = {};
  if (typeof CV != "undefined") CV.tab = "All"; if (typeof NT != "undefined") NT.tab = "All"; if (typeof BILL != "undefined") BILL.sel = null;
}

function closeModal() { var m = document.querySelector(".modal"); if (m) m.remove(); }
function modal2(html, cls) {
  closeModal();
  var m = document.createElement("div"); m.className = "modal"; m.innerHTML = '<div class="dlg ' + (cls || "") + '">' + html + '</div>';
  m.addEventListener("mousedown", function (e) { if (e.target == m) closeModal(); });
  document.body.appendChild(m); return m;
}
document.addEventListener("keydown", function (e) { if (e.key == "Escape") closeModal(); });
function confirmBox(title, text, yesLabel, onYes, danger) {
  window._yes = onYes || function () { };
  modal2('<div class="dlg-head">' + esc(title) + '<button class="x" onclick="closeModal()">&times;</button></div><div class="dlg-body"><p>' + text + '</p><div class="dlg-foot"><button class="btn btn-light" onclick="closeModal()">No, go back</button><button class="btn ' + (danger ? "btn-red" : "btn-green") + '" onclick="closeModal();_yes()">' + esc(yesLabel) + '</button></div></div>', "sm");
}
function toast(msg, type) {
  var t = document.createElement("div"); t.className = "toast " + (type || ""); t.textContent = msg; document.body.appendChild(t);
  setTimeout(function () { t.style.transition = "opacity .3s"; t.style.opacity = 0; setTimeout(function () { t.remove(); }, 300); }, 3200);
}
function kv(k, v) { return "<div class='kv'><span>" + k + "</span><span>" + v + "</span></div>"; }
function downloadCSV(name, rows) {
  var csv = rows.map(function (r) { return r.map(function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
  var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

var PG = {}, PGR = {};
function pgState(k) { return PG[k] || (PG[k] = { page: 1, size: 10 }); }
function pgReset(k) { pgState(k).page = 1; }
function paginate(k, rows) {
  var p = pgState(k), pages = Math.max(1, Math.ceil(rows.length / p.size)); if (p.page > pages) p.page = pages;
  var s = (p.page - 1) * p.size; return { rows: rows.slice(s, s + p.size), start: rows.length ? s + 1 : 0, end: Math.min(rows.length, s + p.size), total: rows.length, pages: pages, page: p.page, size: p.size };
}
function pageList(cur, total) {
  if (total <= 7) { var all = []; for (var i = 1; i <= total; i++) all.push(i); return all; }
  var set = { 1: 1, 2: cur <= 3 ? 1 : 0, 3: cur <= 3 ? 1 : 0 }; set[total] = 1; if (cur >= total - 2) { set[total - 1] = 1; set[total - 2] = 1; }
  for (var d = -1; d <= 1; d++) set[cur + d] = 1;
  var out = [], last = 0; Object.keys(set).map(Number).filter(function (n) { return set[n] && n >= 1 && n <= total; }).sort(function (a, b) { return a - b; }).forEach(function (n) { if (last && n - last > 1) out.push("…"); out.push(n); last = n; });
  return out;
}
function footHTML(k, info, render) {
  PGR[k] = render;
  var pg = "";
  if (info.pages > 1) {
    pg = '<button ' + (info.page == 1 ? "disabled" : "") + ' onclick="gotoPage(\'' + k + '\',' + (info.page - 1) + ')">&lsaquo;</button>';
    pageList(info.page, info.pages).forEach(function (n) { pg += n == "…" ? '<span class="gap">…</span>' : '<button class="' + (n == info.page ? "on" : "") + '" onclick="gotoPage(\'' + k + '\',' + n + ')">' + n + '</button>'; });
    pg += '<button ' + (info.page == info.pages ? "disabled" : "") + ' onclick="gotoPage(\'' + k + '\',' + (info.page + 1) + ')">&rsaquo;</button>';
  } else pg = '<button class="on">1</button>';
  var sz = [10, 25, 50].map(function (n) { return '<option ' + (n == info.size ? "selected" : "") + '>' + n + '</option>'; }).join("");
  return '<div class="foot"><span>Showing ' + info.start + '-' + info.end + ' of ' + info.total + '</span><span class="pager">' + pg + '</span><span>Rows per page <select onchange="setPageSize(\'' + k + '\',this.value)">' + sz + '</select></span></div>';
}
function gotoPage(k, n) { pgState(k).page = n; PGR[k](); }
function setPageSize(k, n) { var p = pgState(k); p.size = +n; p.page = 1; PGR[k](); }
function emptyRow(cols) { return '<tr class="none"><td colspan="' + cols + '">No matching records found.</td></tr>'; }

function niceStep(v) { var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), n = v / p, L = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]; for (var i = 0; i < L.length; i++) if (n <= L[i] + 1e-9) return L[i] * p; return 10 * p; }
function barChart(o) {
  var max = 0; o.series.forEach(function (s) { s.vals.forEach(function (v) { if (v > max) max = v; }); });
  var step = niceStep((max || 1) / 5), top = step * 5, ys = "", ls = "", i;
  for (i = 0; i <= 5; i++) { ys += '<span style="bottom:' + (i * 20) + '%">' + o.fmt(step * i) + '</span>'; if (i > 0) ls += '<div class="ch-line" style="bottom:' + (i * 20) + '%"></div>'; }
  var g = "", x = "";
  o.labels.forEach(function (lb, gi) {
    g += '<div class="ch-g" data-g="' + gi + '">';
    o.series.forEach(function (s, si) { g += '<i class="ch-b" data-s="' + si + '" style="height:0;background:' + s.color + ';transition-delay:' + (gi * 70) + 'ms,0s,0s" data-h="' + (s.vals[gi] / top * 100) + '%"></i>'; });
    g += '</div>'; x += '<span>' + esc(lb) + '</span>';
  });
  var el = $(o.id); el._spec = o;
  el.innerHTML = '<div class="ch" style="--ch:' + (o.h || 200) + 'px"><div class="ch-y">' + ys + '</div><div class="ch-plot">' + ls + '<div class="ch-cols">' + g + '</div></div><div class="ch-x">' + x + '</div></div>';
  el.onmousemove = chartTip; el.onmouseleave = hideTip; growIn(el);
}
function growIn(root) {
  void root.offsetHeight;
  requestAnimationFrame(function () { requestAnimationFrame(function () {
    root.querySelectorAll("[data-h]").forEach(function (e) { e.style.height = e.getAttribute("data-h"); });
    root.querySelectorAll("[data-w]").forEach(function (e) { e.style.width = e.getAttribute("data-w"); });
  }); });
}
function setDonut(id, vals, colors) {
  var el = $(id); el.style.setProperty("--ring", donutGradient(vals, colors)); el.classList.add("anim"); void el.offsetWidth;
  requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove("anim"); }); });
}
function chartTip(e) {
  var gEl = e.target.closest ? e.target.closest(".ch-g") : null, o = this._spec; if (!gEl) { hideTip(); return; }
  var gi = +gEl.getAttribute("data-g"), bEl = e.target.closest(".ch-b"), hot = bEl ? +bEl.getAttribute("data-s") : -1;
  var h = "<h5>" + esc(o.labels[gi]) + "</h5>" + (o.sub ? "<small>" + o.sub + "</small>" : "");
  o.series.forEach(function (s, si) { h += '<p class="' + (si == hot ? "hot" : "") + '"><i style="background:' + s.color + '"></i>' + s.name + '<em>' + (s.exact ? s.exact(s.vals[gi], gi) : o.fmt(s.vals[gi])) + '</em></p>'; });
  if (o.extra) h += "<small style='margin:4px 0 0'>" + o.extra(gi) + "</small>";
  showTip(h, e);
}
function showTip(html, e) {
  var t = $("tip"); if (!t) { t = document.createElement("div"); t.id = "tip"; document.body.appendChild(t); }
  t.innerHTML = html; t.classList.add("on");
  var x = e.clientX + 16, y = e.clientY + 14, w = t.offsetWidth, h = t.offsetHeight;
  if (x + w > innerWidth - 8) x = e.clientX - w - 16; if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  t.style.left = Math.max(8, x) + "px"; t.style.top = Math.max(8, y) + "px";
}
function hideTip() { var t = $("tip"); if (t) t.classList.remove("on"); }
function donutGradient(vals, colors) {
  var tot = vals.reduce(function (a, b) { return a + b; }, 0) || 1, acc = 0, parts = [];
  vals.forEach(function (v, i) { var a = acc / tot * 100; acc += v; parts.push(colors[i] + " " + a + "% " + (acc / tot * 100) + "%"); });
  return "conic-gradient(" + parts.join(",") + ")";
}

function expandCard(btn) {
  var card = btn.closest(".dcard") || btn.closest(".card") || btn.closest(".chart-card");
  if (!card) return;
  var modalOverlay = $("modal-overlay");
  var modalBody = $("modal-body");
  if (modalOverlay && modalBody) {
    var cardClone = card.cloneNode(true);
    var cloneBtn = cardClone.querySelector(".expand-btn");
    if (cloneBtn) cloneBtn.remove();
    modalBody.innerHTML = "";
    modalBody.appendChild(cardClone);
    modalOverlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
}

function closeExpandedCard() {
  var modalOverlay = $("modal-overlay");
  if (modalOverlay) {
    modalOverlay.classList.add("hidden");
    document.body.style.overflow = "";
  }
}