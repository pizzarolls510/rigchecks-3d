// RigCheck 3D — safe PWA update handoff for iOS/Home Screen.
(() => {
  if (!("serviceWorker" in navigator)) return;

  const RELOAD_KEY = "rigcheck-controller-reload";
  let registration = null;
  let refreshing = false;

  function reloadForNewController() {
    if (refreshing) return;

    const now = Date.now();
    const lastReload = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (now - lastReload < 5000) return;

    refreshing = true;
    sessionStorage.setItem(RELOAD_KEY, String(now));

    // Let the new worker fully take control before asking WebKit for fresh HTML.
    window.setTimeout(() => window.location.reload(), 120);
  }

  navigator.serviceWorker.addEventListener("controllerchange", reloadForNewController);

  async function checkForUpdate() {
    try {
      await registration?.update();
    } catch (error) {
      console.warn("RigCheck update check skipped", error);
    }
  }

  window.addEventListener("load", async () => {
    try {
      registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      await checkForUpdate();
    } catch (error) {
      console.warn("RigCheck service worker unavailable", error);
    }
  });

  // iOS may suspend the PWA for long stretches. Check again whenever the user
  // returns instead of requiring a separate Safari visit.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
  window.addEventListener("focus", checkForUpdate);
})();
