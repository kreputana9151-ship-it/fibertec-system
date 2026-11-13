/* Adds a show/hide (eye) button to every password box, including ones that appear later (pop-ups). */
(function () {
  var EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  function add(input) {
    if (input.dataset.pwToggle) return; input.dataset.pwToggle = "1";
    var wrap = document.createElement("span"), btn = document.createElement("button");
    wrap.className = "pw-wrap"; input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    btn.type = "button"; btn.className = "pw-toggle"; btn.innerHTML = EYE; btn.title = "Show password"; btn.setAttribute("aria-label", "Show password"); btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });        // keep typing in the box
    btn.addEventListener("click", function () {
      var show = input.type === "password"; input.type = show ? "text" : "password";
      btn.innerHTML = show ? EYE_OFF : EYE; btn.title = btn.ariaLabel = show ? "Hide password" : "Show password"; btn.setAttribute("aria-label", btn.title); btn.setAttribute("aria-pressed", String(show));
    });
    wrap.appendChild(btn);
  }
  function scan(root) { (root.querySelectorAll ? root : document).querySelectorAll("input[type=password]").forEach(add); }
  scan(document);
  new MutationObserver(function () { scan(document); }).observe(document.body, { childList: true, subtree: true });
})();
