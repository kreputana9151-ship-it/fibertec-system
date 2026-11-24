/* Payments Verification Queue - Single-Server FIFO (M/M/1), LIVE from the backend.
   Queue #1 = oldest 'Pending' payment (ORDER BY created_at ASC). Only Queue #1 can be verified or rejected. */
var PAY = {
  loaded: false, error: "", queue: [], metrics: null, records: [], activity: [], at: 0,
  statusCounts: { active: 0, grace_period: 0, under_review: 0, terminated: 0 }
}, BUSY = false, STAFF_RENDERED_SIGNATURE = "";
function staffDataSignature() {
  return JSON.stringify([PAY.queue, PAY.metrics, PAY.records, PAY.activity, PAY.statusCounts, STAFF_REQUESTS, LIVE_STAFF_CLIENTS, PAY.error]);
}

function fmtTs(v) {
  var d = parseISO(v);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function fmtDate(v) {
  var d = parseISO(v);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDur(ms) {
  var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return d ? d + "d " + h + "h " + m + "m" : h ? h + "h " + m + "m " + x + "s" : m + "m " + x + "s";
}
function subMs(p) { return Date.parse(p.submitted_at); }                      // real created_at of the payment
function qInfo(p) { return "Submitted " + fmtTs(p.submitted_at) + " &middot; " + p.payment_type + " &middot; " + (p.method == "GCash" ? "GCash Ref " + fmtRef(p.reference_no || "") : "Cash proof") + " &middot; " + peso(p.amount); }
function waitSpan(p) { return "<span class='fifo-wait'>Waiting: <b data-ts='" + subMs(p) + "'>" + fmtDur(Date.now() - subMs(p)) + "</b></span>"; }
function headCard(p) {
  return "<div class='fifo-now'><div class='fifo-top'><span class='fifo-badge'>QUEUE #1 &middot; NOW SERVING / NEXT TO VERIFY</span>" + waitSpan(p) + "</div>" +
    "<div class='fifo-body'><span><b>" + esc(p.name) + "</b> (" + p.account_no + ")<small>" + qInfo(p) + "</small></span>" +
    "<span class='fifo-act'><button class='btn btn-green' onclick='askVerify(" + p.payment_id + ")'>Match / Valid</button><button class='btn btn-red' onclick='rejectRef(" + p.payment_id + ")'>Reject / Flag</button></span></div></div>";
}
function waitRow(p) {
  return "<div class='fifo-row'><span class='fifo-n'>#" + p.queue_no + "</span><span class='fifo-who'><b>" + esc(p.name) + "</b> (" + p.account_no + ")<small>" + qInfo(p) + "</small></span>" + waitSpan(p) +
    "<span class='badge orange'>&#128274; Waiting in Queue</span>" +
    "<span class='fifo-act'><button class='btn btn-green' disabled title='Only Queue #1 can be verified'>Match / Valid</button><button class='btn btn-red' disabled title='Only Queue #1 can be verified'>Reject / Flag</button></span></div>";
}
function metricsHTML() {
  var m = PAY.metrics || {};
  function tile(k, v, id, note) { return "<div class='fifo-m'><span>" + k + "</span><b" + (id ? " id='" + id + "'" : "") + ">" + v + "</b><small>" + note + "</small></div>"; }
  var mu = m.mu_per_hour, rho = m.rho;
  return tile("Queue length (L<sub>q</sub>)", PAY.queue.length, "", "pending in buffer") +
    tile("Arrival rate (&lambda;)", Number(m.lambda_per_hour || 0).toFixed(0) + "/hr", "", "submissions in the last hour") +
    tile("Service rate (&mu;)", mu ? Number(mu).toFixed(1) + "/hr" : "&mdash;", "", mu ? "avg " + fmtDur(3600000 / mu) + " per payment" : "needs a verification in the last 24 h") +
    tile("Utilization (&rho; = &lambda;/&mu;)", rho != null ? Number(rho).toFixed(2) : "&mdash;", "", rho != null && rho >= 1 ? "queue keeps growing" : "stable if below 1") +
    tile("Avg. wait (W<sub>q</sub>)", "", "m-wq", "average of everyone waiting") + tile("Longest wait", "", "m-long", "Queue #1 (head)");
}
function renderQueue() {
  var q = PAY.queue, box = $("queue"); if (!box) return;
  $("pcount").innerHTML = q.length;
  $("q-updated").textContent = PAY.at ? "Updated " + new Date(PAY.at).toLocaleTimeString("en-PH") : "";
  $("fifo-metrics").innerHTML = PAY.loaded ? metricsHTML() : "";
  if (!PAY.loaded && !PAY.error) box.innerHTML = "<p class='empty'>Loading the queue...</p>";
  else if (PAY.error && !PAY.loaded) box.innerHTML = "<p class='empty'>" + esc(PAY.error) + " <a style='color:#2b86ff;cursor:pointer' onclick='refreshPayments()'>Try again</a></p>";
  else if (!q.length) box.innerHTML = "<p class='empty'>No pending payments in the verification queue.</p>";
  else box.innerHTML = headCard(q[0]) + (q.length > 1 ? "<p class='fifo-sub'>Waiting in queue (" + (q.length - 1) + ") &mdash; oldest first</p><div class='q-scroll'>" + q.slice(1).map(waitRow).join("") + "</div>" : "");
  tickQueue();
}
function tickQueue() {
  var n = Date.now(), q = PAY.queue;
  document.querySelectorAll("[data-ts]").forEach(function (e) { e.textContent = fmtDur(n - Number(e.getAttribute("data-ts"))); });
  var wq = $("m-wq"), lg = $("m-long");
  if (wq) wq.textContent = q.length ? fmtDur(q.reduce(function (a, p) { return a + n - subMs(p); }, 0) / q.length) : "0m 0s";
  if (lg) lg.textContent = q.length ? fmtDur(n - subMs(q[0])) : "0m 0s";
}
/* load queue + metrics, payment records and activity from the API, then redraw */
function refreshPayments() {
  return Promise.all([
    apiCall("GET", "/api/staff/payments/queue").then(function (d) { PAY.queue = d.queue; PAY.metrics = d.metrics; }),
    apiCall("GET", "/api/staff/payments").then(function (d) { PAY.records = d.filter(function (r) { return r.status != "Pending"; }); }),
    apiCall("GET", "/api/staff/activity").then(function (d) { PAY.activity = d; }),
    apiCall("GET", "/api/staff/dashboard").then(function (d) { PAY.statusCounts = d; }),
    apiCall("GET", "/api/staff/cancellations").then(function (rows) {
      STAFF_REQUESTS = rows.filter(function (r) { return r.status === "Pending"; }).map(function (r) {
        return { id: r.request_id, acc: r.account_no, name: r.name, date: r.request_date, reason: r.reason, status: r.status };
      });
    }),
    syncStaffClients(true)
  ]).then(function () { PAY.loaded = true; PAY.error = ""; PAY.at = Date.now(); })
    .catch(function (e) { if (e && e.status == 401) return; PAY.error = (e && e.message) || "Cannot reach the server."; })
    .then(function () {
      if (!liveRefreshPaused() && STAFF_RENDERED_SIGNATURE !== staffDataSignature()) {
        var signature = staffDataSignature();
        return renderPreservingScroll(renderStaffLivePage).then(function () {
          STAFF_RENDERED_SIGNATURE = signature;
        });
      }
    });
}
function startPolling() {                                              // new client submissions show up by themselves
  refreshPayments();
  setInterval(function () { if (!liveRefreshPaused() && !BUSY) refreshPayments(); }, 8000);
  setInterval(tickQueue, 1000);
}
