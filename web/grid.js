(function () {
  const host = location.hostname;
  window.SRSite = {
    isLocal: host === "127.0.0.1" || host === "localhost" || host === "[::1]",
    mountGrid: mountGrid,
  };

  function mountGrid(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    const GAP = 48;
    let mx = window.innerWidth * 0.6;
    let my = window.innerHeight * 0.28;
    let tx = mx;
    let ty = my;
    let w = 0;
    let h = 0;
    let dpr = 1;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      tx += (mx - tx) * 0.085;
      ty += (my - ty) * 0.085;
      const ox = (tx - w / 2) * 0.018;
      const oy = (ty - h / 2) * 0.018;
      ctx.clearRect(0, 0, w, h);

      const glow = ctx.createRadialGradient(tx, ty, 0, tx, ty, 420);
      glow.addColorStop(0, "rgba(61,255,176,0.13)");
      glow.addColorStop(0.35, "rgba(110,168,255,0.06)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      ctx.beginPath();
      for (let x = -GAP; x <= w + GAP; x += GAP) {
        ctx.moveTo(x + ox, 0);
        ctx.lineTo(x + ox, h);
      }
      for (let y = -GAP; y <= h + GAP; y += GAP) {
        ctx.moveTo(0, y + oy);
        ctx.lineTo(w, y + oy);
      }
      ctx.strokeStyle = "rgba(180,200,220,0.045)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const rad = 140;
      for (let x = -GAP; x <= w + GAP; x += GAP) {
        const px = x + ox;
        for (let y = -GAP; y <= h + GAP; y += GAP) {
          const py = y + oy;
          const dx = px - tx;
          const dy = py - ty;
          const dist = Math.hypot(dx, dy);
          if (dist > rad) continue;
          const t = 1 - dist / rad;
          const r = 1.1 + t * 2.4;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(61,255,176,${0.08 + t * 0.55})`;
          ctx.fill();
        }
      }
      requestAnimationFrame(draw);
    }

    window.addEventListener("pointermove", (e) => {
      mx = e.clientX;
      my = e.clientY;
    }, { passive: true });
    window.addEventListener("resize", resize);
    resize();
    requestAnimationFrame(draw);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("bg-grid");
    if (canvas) mountGrid(canvas);
  });
})();
