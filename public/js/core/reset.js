// forgot-password.html: step 1 = ask for a reset link, step 2 (link has ?token=) = set a new password
var TOKEN = new URLSearchParams(location.search).get("token");
function send(path, body) {
  return fetch("/api/auth/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
}
function show(id, msg, good) { var e = document.getElementById(id); e.className = good ? "ok" : "error"; e.textContent = msg; }
function requestLink() {
  var id = document.getElementById("fp-id").value;
  if (!id) return show("fp-msg", "Please enter your account number or email.");
  if (/\s/.test(id)) return show("fp-msg", "Account number or email must not contain whitespace.");
  send("forgot-password", { loginId: id }).then(function (r) { show("fp-msg", r.data.message || r.data.error, r.ok); })
    .catch(function () { show("fp-msg", "Cannot reach the server. Please try again."); });
}
function saveNewPassword() {
  var n = document.getElementById("rp-new").value, c = document.getElementById("rp-confirm").value;
  if (/\s/.test(n) || /\s/.test(c)) return show("rp-msg", "Password must not contain whitespace.");
  if (n.length < 8) return show("rp-msg", "Password must be at least 8 characters.");
  if (n != c) return show("rp-msg", "The two passwords do not match.");
  send("reset-password", { token: TOKEN, newPassword: n }).then(function (r) {
    if (!r.ok) return show("rp-msg", r.data.error);
    show("rp-msg", "Password saved. Redirecting to log in...", true); setTimeout(function () { location.href = "index.html"; }, 1500);
  }).catch(function () { show("rp-msg", "Cannot reach the server. Please try again."); });
}
if (TOKEN) { document.getElementById("fp-form").classList.add("hidden"); document.getElementById("rp-form").classList.remove("hidden"); }
