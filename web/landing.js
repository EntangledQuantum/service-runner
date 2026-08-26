(function () {
  const local = window.SRSite && window.SRSite.isLocal;
  document.querySelectorAll(".local-only").forEach((el) => {
    el.hidden = !local;
  });
  document.querySelectorAll(".gh-only").forEach((el) => {
    el.hidden = Boolean(local);
  });
  const origin = document.getElementById("local-origin");
  if (origin) origin.textContent = location.host;
})();
