/* ---------------------------------------------------------------------------
   Colour — drawing engine.

   Design goals, in order:
     1. Never break, whatever a small child taps or how many fingers land.
     2. Feel instant and smooth (mouse / touch / S Pen alike).
     3. Stay small and readable.

   The canvas is transparent; the "paper" is the canvas element's CSS
   background. That single choice buys us three things for free:
     - a real eraser (destination-out clears back to the paper),
     - instant dark mode (recolour the CSS paper, drawing untouched),
     - a clean resize (we never repaint a background into the bitmap).
--------------------------------------------------------------------------- */

(() => {
  "use strict";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d", { alpha: true });

  // --- Current tool state ------------------------------------------------
  const tool = {
    color: "#e5342b",
    size: 24,
    erasing: false,
  };

  // The pointer that owns the current stroke. Only one at a time — extra
  // fingers (a resting palm, a curious sibling) are simply ignored.
  let activePointerId = null;
  // Recent points of the in-progress stroke, used for curve smoothing.
  let pts = [];

  // --- Canvas sizing -----------------------------------------------------
  // Device-pixel buffer for crisp strokes. On resize we redraw the previous
  // bitmap 1:1 (no scaling) so shrinking then growing restores exact pixels
  // instead of blurring them.

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width === w && canvas.height === h) return;

    let snapshot = null;
    if (canvas.width && canvas.height) {
      snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext("2d").drawImage(canvas, 0, 0);
    }

    canvas.width = w;
    canvas.height = h;

    if (snapshot) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(snapshot, 0, 0); // 1:1, top-left — no squish
    }

    // Draw in CSS pixels; the transform maps them to device pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  // --- Drawing -----------------------------------------------------------

  // Set colour + compositing once per stroke; width is set per segment
  // because pressure can vary it mid-stroke.
  function beginStrokeStyle() {
    if (tool.erasing) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#000";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = tool.color;
      ctx.fillStyle = tool.color;
    }
  }

  // S Pen (and other real styli) report 0..1 pressure. Map it to width for a
  // natural, tapering line. Touch/mouse have no useful pressure, so they draw
  // at the chosen size flat.
  function widthFor(e) {
    if (e.pointerType === "pen" && e.pressure > 0) {
      return tool.size * (0.35 + 0.9 * e.pressure);
    }
    return tool.size;
  }

  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function dot(p) {
    ctx.lineWidth = p.w;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw the newest smooth segment. We route the curve through the midpoints
  // between sample points, using each sample as a quadratic control point.
  // Consecutive segments meet at those midpoints, so the whole stroke is
  // continuous and smooth even when samples are sparse (fast movements).
  function drawSegment() {
    const n = pts.length;
    if (n < 2) return;

    if (n === 2) {
      // First segment: from the start point to the first midpoint.
      const m = mid(pts[0], pts[1]);
      ctx.lineWidth = pts[1].w;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
      return;
    }

    const p0 = pts[n - 3];
    const p1 = pts[n - 2];
    const p2 = pts[n - 1];
    ctx.lineWidth = p1.w;
    ctx.beginPath();
    ctx.moveTo(mid(p0, p1).x, mid(p0, p1).y);
    ctx.quadraticCurveTo(p1.x, p1.y, mid(p1, p2).x, mid(p1, p2).y);
    ctx.stroke();
  }

  // --- Pointer handling --------------------------------------------------

  function onPointerDown(e) {
    if (activePointerId !== null) return; // a stroke is already in progress
    activePointerId = e.pointerId;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {}
    beginStrokeStyle();
    pts = [{ x: e.clientX, y: e.clientY, w: widthFor(e) }];
    dot(pts[0]); // a tap leaves a dot
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    // Coalesced events expose every sub-frame sample the OS buffered — the
    // single biggest win for smoothness on fast strokes. Fall back to the
    // event itself when unavailable.
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const events = coalesced && coalesced.length ? coalesced : [e];
    for (const ev of events) {
      pts.push({ x: ev.clientX, y: ev.clientY, w: widthFor(ev) });
      drawSegment();
    }
    e.preventDefault();
  }

  function endStroke(e) {
    if (e.pointerId !== activePointerId) return;
    // Close the tail: connect the last midpoint to the final point.
    const n = pts.length;
    if (n >= 2) {
      const p1 = pts[n - 2];
      const p2 = pts[n - 1];
      ctx.lineWidth = p2.w;
      ctx.beginPath();
      ctx.moveTo(mid(p1, p2).x, mid(p1, p2).y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    activePointerId = null;
    pts = [];
    e.preventDefault();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", endStroke);

  // --- Tool selection ----------------------------------------------------

  const swatches = document.querySelectorAll(".swatch");
  swatches.forEach((btn) => {
    // Select on pointer-down so even a quick tap-and-drag picks instantly —
    // no need to press and release on the same swatch.
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      swatches.forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-checked", "true");

      if (btn.hasAttribute("data-eraser")) {
        tool.erasing = true;
      } else {
        tool.erasing = false;
        tool.color = btn.dataset.color;
      }
    });
  });

  // Pen-size slider. The thumb's own size tracks the pen size so you can see
  // how big the pen is (16px .. 44px thumb across the 4 .. 80 pen range).
  const sizeInput = document.getElementById("size");
  const knob = document.querySelector(".slider-knob");
  function syncSize() {
    tool.size = Number(sizeInput.value);
    const min = Number(sizeInput.min);
    const max = Number(sizeInput.max);
    const t = (tool.size - min) / (max - min);
    // Knob spans 16px .. 64px — the same max size as the active colour swatch.
    knob.style.setProperty("--thumb", (16 + t * 48).toFixed(1) + "px");
    // Its centre reaches the rims: 0% at min, 100% at max.
    knob.style.left = (t * 100).toFixed(2) + "%";
  }
  sizeInput.addEventListener("input", syncSize);
  syncSize();

  // --- Settings menu -----------------------------------------------------

  const settings = document.getElementById("settings");
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsMenu = document.getElementById("settings-menu");

  function openMenu(open) {
    settingsMenu.hidden = !open;
    settingsToggle.setAttribute("aria-expanded", String(open));
  }

  settingsToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(settingsMenu.hidden);
  });

  // Tap anywhere else closes the menu.
  document.addEventListener("pointerdown", (e) => {
    if (!settings.contains(e.target)) openMenu(false);
  });

  // Dark mode — flips the CSS paper + chrome instantly, and is remembered.
  const darkBtn = document.getElementById("btn-dark");
  const themeMeta = document.getElementById("theme-color");
  function applyTheme(dark) {
    document.body.classList.toggle("dark", dark);
    darkBtn.textContent = dark ? "Light mode" : "Dark mode";
    themeMeta.setAttribute("content", dark ? "#0e0f11" : "#fafafa");
    try {
      localStorage.setItem("colour-theme", dark ? "dark" : "light");
    } catch (_) {}
  }
  darkBtn.addEventListener("click", () => {
    openMenu(false);
    applyTheme(!document.body.classList.contains("dark"));
  });

  document.getElementById("btn-fullscreen").addEventListener("click", () => {
    openMenu(false);
    const el = document.documentElement;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen(); // Safari / older WebKit
    }
  });

  document.getElementById("btn-save").addEventListener("click", () => {
    openMenu(false);
    // The canvas is transparent, so bake the paper colour behind it first.
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext("2d");
    octx.fillStyle =
      getComputedStyle(canvas).backgroundColor || "#ffffff";
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "my-drawing.png";
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  });

  document.getElementById("btn-clear").addEventListener("click", () => {
    openMenu(false);
    // One deliberate confirm so a picture can't vanish by accident.
    if (confirm("Start over? This clears your drawing.")) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  });

  // --- Guard rails: stop the browser from hijacking touches --------------
  // With touch-action:none most gestures are already dead; these catch the
  // stragglers (long-press menu, pinch-zoom, iOS gesture events).
  const swallow = (e) => e.preventDefault();
  document.addEventListener("contextmenu", swallow);
  document.addEventListener("gesturestart", swallow);
  document.addEventListener("gesturechange", swallow);
  document.addEventListener("touchmove", swallow, { passive: false });
  document.addEventListener("dblclick", swallow);

  // --- Boot --------------------------------------------------------------
  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem("colour-theme") || "light";
  } catch (_) {}
  applyTheme(savedTheme === "dark");

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  resize();
})();
