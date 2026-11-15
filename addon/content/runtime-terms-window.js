/** Present the packaged Microsoft-only agreement and record only an explicit click. */

/** Closing or pressing Escape never records agreement. */
window.addEventListener("load", function initializeRuntimeTerms() {
  const { terms, text } = window.arguments[0];
  const accept = document.getElementById("terms-accept");
  const decline = document.getElementById("terms-decline");
  const status = document.getElementById("terms-status");
  // Keep both consent actions on-screen at Windows display scaling and smaller resolutions.
  const frameMargin = 24;
  if (window.screen) {
    window.resizeTo(Math.min(window.outerWidth, window.screen.availWidth - frameMargin),
      Math.min(window.outerHeight, window.screen.availHeight - frameMargin));
  }
  document.getElementById("terms-text").textContent = text;
  if (terms.accepted()) {
    accept.hidden = true;
    decline.textContent = "关闭";
    status.textContent = "当前条款已同意；升级或重启不会重复确认相同条款。";
  } else {
    accept.disabled = false;
    status.textContent = "请阅读以上完整条款。“同意并继续”仅确认运行库条款，不调用翻译服务商。";
  }
  decline.addEventListener("click", function declineTerms() { window.close(); });
  accept.addEventListener("click", function acceptTerms() {
    try { terms.accept(); window.close(); }
    catch (error) { status.textContent = "同意状态未能保存，请重试：" + error.message; }
  });
  window.addEventListener("keydown", function closeOnEscape(event) {
    if (event.key === "Escape") window.close();
  });
  // Enter must not silently accept an agreement the user has not chosen.
  decline.focus();
});
