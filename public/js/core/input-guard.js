/* Blocks whitespace in credential and identifier inputs, including dynamically created modals. */
(function () {
  var FIELD_NAMES = {
    account_no: true, accountno: true, account_number: true, accountnumber: true,
    acc_no: true, accno: true, acc_number: true, accnumber: true,
    login: true, login_id: true, loginid: true, login_identifier: true,
    loginidentifier: true, username: true, user_name: true,
    email: true, email_address: true, emailaddress: true, password: true,
    confirm_password: true, confirmpassword: true,
    new_password: true, newpassword: true, ref_no: true, refno: true,
    reference_no: true, referenceno: true
  };
  var FIELD_IDS = {
    account: true, fp_id: true, password: true, cp_new: true, cp_confirm: true,
    rp_new: true, rp_confirm: true, r_email: true, e_email: true, r_pass: true,
    cx_pw: true, ref: true
  };

  function isTargetInput(target) {
    if (!target || target.tagName !== "INPUT") return false;
    var name = (target.getAttribute("name") || "").toLowerCase().replace(/-/g, "_");
    var id = (target.id || "").toLowerCase().replace(/-/g, "_");
    var autocomplete = (target.getAttribute("autocomplete") || "").toLowerCase();
    return !!FIELD_NAMES[name] || !!FIELD_NAMES[id] || !!FIELD_IDS[id] ||
      target.type === "email" || target.type === "password" ||
      autocomplete === "username" || autocomplete === "email" ||
      autocomplete === "current-password" || autocomplete === "new-password";
  }

  document.addEventListener("keydown", function (e) {
    if (isTargetInput(e.target) && (e.key === " " || e.code === "Space")) e.preventDefault();
  });

  document.addEventListener("input", function (e) {
    if (!isTargetInput(e.target)) return;
    var clean = e.target.value.replace(/\s+/g, "");
    if (clean !== e.target.value) e.target.value = clean;
  }, true);

  document.addEventListener("paste", function (e) {
    if (!isTargetInput(e.target)) return;
    var input = e.target;
    setTimeout(function () {
      var clean = input.value.replace(/\s+/g, "");
      if (clean !== input.value) input.value = clean;
    }, 0);
  });
})();
