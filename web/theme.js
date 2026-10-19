/* Runs in <head> before first paint so the theme never flashes. */
(function () {
  var t = null;
  try {
    t = localStorage.getItem("sr-theme");
  } catch (e) {
    /* storage blocked */
  }
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", t);
})();
