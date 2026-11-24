(function () {
  var activeRequests = 0, failedRequestWave = false, loadingTimer = null;
  var nativeFetch = window.fetch.bind(window);
  var banner, loading;

  function ensureIndicators() {
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "server-error-banner";
      banner.setAttribute("role", "alert");
      banner.setAttribute("aria-live", "assertive");
      banner.innerHTML = "<span>Unable to connect to server. Please check your connection.</span><button type='button' aria-label='Dismiss connection message'>&times;</button>";
      banner.querySelector("button").addEventListener("click", function () { banner.classList.remove("visible"); });
      document.body.appendChild(banner);
    }
    if (!loading) {
      loading = document.createElement("div");
      loading.className = "api-loading-indicator";
      loading.setAttribute("role", "status");
      loading.setAttribute("aria-live", "polite");
      loading.innerHTML = "<span class='loading-spinner' aria-hidden='true'></span>Loading data...";
      document.body.appendChild(loading);
    }
  }

  function isApiRequest(input) {
    try {
      var address = typeof input === "string" ? input : input.url;
      var url = new URL(address, window.location.href);
      return url.origin === window.location.origin && (url.pathname === "/api" || url.pathname.indexOf("/api/") === 0);
    } catch (e) {
      return false;
    }
  }

  function finishRequest(failed) {
    activeRequests = Math.max(0, activeRequests - 1);
    if (failed) failedRequestWave = true;
    if (activeRequests === 0) {
      if (failedRequestWave) {
        ensureIndicators();
        banner.classList.add("visible");
      } else if (banner) {
        banner.classList.remove("visible");
      }
      failedRequestWave = false;
      if (loadingTimer) clearTimeout(loadingTimer);
      loadingTimer = null;
      if (loading) loading.classList.remove("visible");
    }
  }

  window.fetch = function (input, init) {
    if (!isApiRequest(input)) return nativeFetch(input, init);
    activeRequests++;
    ensureIndicators();
    if (!loadingTimer && loading) {
      loadingTimer = setTimeout(function () {
        if (activeRequests > 0) loading.classList.add("visible");
      }, 180);
    }
    return nativeFetch(input, init).then(function (response) {
      finishRequest(response.status >= 500);
      return response;
    }, function (error) {
      finishRequest(true);
      throw error;
    });
  };
})();

function submitFormOnce(form, handler) {
  if (!form || form.getAttribute("data-submitting") === "true") return false;
  form.setAttribute("data-submitting", "true");
  var controls = Array.prototype.slice.call(form.querySelectorAll("button[type='submit'], input[type='submit']"));
  var previous = controls.map(function (control) {
    var wasDisabled = control.disabled;
    control.disabled = true;
    return wasDisabled;
  });
  function unlock() {
    form.removeAttribute("data-submitting");
    controls.forEach(function (control, index) { control.disabled = previous[index]; });
  }
  try {
    var result = handler();
    if (result && typeof result.then === "function") result.then(unlock, unlock);
    else unlock();
  } catch (error) {
    unlock();
    throw error;
  }
  return false;
}

function runLockedButton(button, action) {
  if (!button || button.disabled) return Promise.resolve();
  var wasDisabled = button.disabled;
  button.disabled = true;
  return Promise.resolve().then(action).then(function (result) {
    if (button.isConnected) button.disabled = wasDisabled;
    return result;
  }, function (error) {
    if (button.isConnected) button.disabled = wasDisabled;
    throw error;
  });
}
