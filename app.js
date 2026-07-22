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

   Colour mixing (menu toggle, default on): strokes behave like real paint
   rather than opaque ink. New paint is mixed into whatever is already on the
   paper with pigment mixing — Mixbox (CC BY-NC, see THIRD-PARTY-NOTICES.md)
   when present, else spectral.js (MIT) — so blue + red makes purple, blue +
   yellow makes green, and repainting shifts the ratio — a second coat of red
   over one of blue reads as a reddish purple. The alpha
   channel doubles as the *amount* of paint on a pixel, so the mix weight is
   (paint this stroke lays down) : (paint already there). Each stroke mixes
   against a snapshot of the canvas taken when it began, which keeps one
   stroke uniform instead of compounding with itself where segments overlap;
   lift and stroke again to mix another coat.
--------------------------------------------------------------------------- */

(() => {
  "use strict";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d", { alpha: true });

  // Offscreen buffers for paint mixing. `mask` collects the in-progress
  // stroke's coverage as plain black ink; `snap` freezes the canvas as it was
  // when the stroke began.
  const mask = document.createElement("canvas");
  const maskCtx = mask.getContext("2d", { willReadFrequently: true });
  const snap = document.createElement("canvas");
  const snapCtx = snap.getContext("2d", { willReadFrequently: true });

  // Two pigment engines, picked by the "Mix style" menu item: "colour" is
  // Mixbox (vivid — mixes stay close to the raw RGB swatches), "paint" is
  // spectral.js (softer, how real paint actually behaves). Neither loading
  // must never kill drawing — we just fall back to plain opaque strokes and
  // hide the menu toggles.
  const hasMixbox = typeof mixbox !== "undefined";
  const hasSpectral = typeof spectral !== "undefined";
  const canMix = hasMixbox || hasSpectral;
  let engine = hasMixbox ? "mixbox" : hasSpectral ? "spectral" : null;

  // --- Current tool state ------------------------------------------------
  const tool = {
    color: "#e0356b",
    size: 24,
    erasing: false,
    mixing: true,
  };

  // The pointer that owns the current stroke. Only one at a time — extra
  // fingers (a resting palm, a curious sibling) are simply ignored.
  let activePointerId = null;
  // Recent points of the in-progress stroke, used for curve smoothing.
  let pts = [];
  let dpr = 1;

  // --- Paint mixing ------------------------------------------------------

  const hexToRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  // The current pen colour as pigment: `mix` is the engine's working form
  // (Mixbox latent vector / spectral.Color), `rgb` its plain sRGB ints.
  let brush = null;

  function setBrush(color) {
    if (!canMix) return;
    const rgb = hexToRgb(color);
    brush = {
      rgb,
      mix: engine === "mixbox" ? mixbox.rgbToLatent(rgb) : new spectral.Color(rgb),
    };
  }

  // Routing for the current stroke: mixing strokes draw into the mask and are
  // composited by flushMix(); eraser / plain strokes draw straight to ctx.
  let strokeCtx = ctx;
  let mixingStroke = false;
  let strokeEngine = null; // engine captured at stroke start
  let strokeBrush = null; // brush captured at stroke start
  let strokeBrushRGB = null; // its sRGB ints, for laying on bare paper
  let dirty = null; // region touched since the last flush, in CSS px
  let mixRaf = 0;

  // Mixed-pixel cache: real drawings have few distinct colours under a brush,
  // so almost every pixel is a repeat. Entries are only valid for the brush
  // they were mixed with.
  const MIXQ = 63; // paint amounts quantised to 64 levels — invisible
  const mixCache = new Map();
  let mixCacheBrush = null;

  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // Mix `laid` parts of the stroke's pigment into `had` parts of the colour
  // already on the pixel; returns sRGB ints.
  function mixPaint(r, g, b, had, laid) {
    if (strokeEngine === "mixbox") {
      const zA = mixbox.rgbToLatent(r, g, b);
      const zB = strokeBrush.mix;
      const t = laid / (had + laid);
      const z = new Array(mixbox.LATENT_SIZE);
      for (let i = 0; i < z.length; i++) z[i] = zA[i] + (zB[i] - zA[i]) * t;
      return mixbox.latentToRgb(z); // already clamped ints
    }
    const mixed = spectral.mix(
      [new spectral.Color([r, g, b]), had],
      [strokeBrush.mix, laid]
    ).sRGB;
    return [clamp255(mixed[0]), clamp255(mixed[1]), clamp255(mixed[2])];
  }

  function markDirty(x0, y0, x1, y1, w) {
    if (!mixingStroke) return;
    const pad = w / 2 + 2; // half the pen plus antialiasing slack
    x0 -= pad;
    y0 -= pad;
    x1 += pad;
    y1 += pad;
    if (!dirty) {
      dirty = { x0, y0, x1, y1 };
    } else {
      if (x0 < dirty.x0) dirty.x0 = x0;
      if (y0 < dirty.y0) dirty.y0 = y0;
      if (x1 > dirty.x1) dirty.x1 = x1;
      if (y1 > dirty.y1) dirty.y1 = y1;
    }
    if (!mixRaf) mixRaf = requestAnimationFrame(flushMix);
  }

  // Composite the stroke-so-far onto the paper: every pixel the stroke covers
  // gets the brush pigment mixed into the paint already there. Runs at most
  // once per frame, over just the region touched since the last flush.
  // Recomputing a pixel is idempotent (snapshot + total coverage in, colour
  // out), so overlapping dirty regions across frames are harmless.
  function flushMix() {
    mixRaf = 0;
    const r = dirty;
    dirty = null;
    if (!r) return;

    const x = Math.max(0, Math.floor(r.x0 * dpr));
    const y = Math.max(0, Math.floor(r.y0 * dpr));
    const x2 = Math.min(canvas.width, Math.ceil(r.x1 * dpr));
    const y2 = Math.min(canvas.height, Math.ceil(r.y1 * dpr));
    if (x >= x2 || y >= y2) return;

    if (mixCacheBrush !== strokeBrush) {
      mixCache.clear();
      mixCacheBrush = strokeBrush;
    }

    const cov = maskCtx.getImageData(x, y, x2 - x, y2 - y).data;
    const img = snapCtx.getImageData(x, y, x2 - x, y2 - y);
    const px = img.data;

    for (let i = 0; i < px.length; i += 4) {
      const laid = cov[i + 3] / 255; // paint this stroke has laid here
      if (laid === 0) continue;
      const had = px[i + 3] / 255; // paint that was already on the paper

      const qLaid = Math.round(laid * MIXQ);
      const qHad = Math.round(had * MIXQ);

      if (qHad === 0) {
        // Bare paper: the brush colour goes down as-is.
        px[i] = strokeBrushRGB[0];
        px[i + 1] = strokeBrushRGB[1];
        px[i + 2] = strokeBrushRGB[2];
      } else if (qLaid > 0) {
        const key =
          (((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]) * 64 + qHad) * 64 +
          qLaid;
        let out = mixCache.get(key);
        if (!out) {
          out = mixPaint(px[i], px[i + 1], px[i + 2], qHad / MIXQ, qLaid / MIXQ);
          if (mixCache.size > 100000) mixCache.clear();
          mixCache.set(key, out);
        }
        px[i] = out[0];
        px[i + 1] = out[1];
        px[i + 2] = out[2];
      }
      px[i + 3] = Math.min(255, Math.round((had + laid) * 255));
    }

    ctx.putImageData(img, x, y);
  }

  // End the active stroke where it is (pointer lost, window resized).
  function cancelStroke() {
    if (activePointerId === null) return;
    if (mixRaf) cancelAnimationFrame(mixRaf);
    mixRaf = 0;
    flushMix();
    mixingStroke = false;
    activePointerId = null;
    pts = [];
  }

  // --- Canvas sizing -----------------------------------------------------
  // Device-pixel buffer for crisp strokes. On resize we redraw the previous
  // bitmap 1:1 (no scaling) so shrinking then growing restores exact pixels
  // instead of blurring them.

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width === w && canvas.height === h) return;

    // Resizing swaps the buffers out from under an in-progress stroke.
    cancelStroke();

    let snapshot = null;
    if (canvas.width && canvas.height) {
      snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext("2d").drawImage(canvas, 0, 0);
    }

    canvas.width = w;
    canvas.height = h;
    mask.width = w;
    mask.height = h;
    snap.width = w;
    snap.height = h;

    if (snapshot) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(snapshot, 0, 0); // 1:1, top-left — no squish
    }

    // Draw in CSS pixels; the transform maps them to device pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    maskCtx.lineCap = "round";
    maskCtx.lineJoin = "round";
    // snapCtx stays untransformed: it only copies device pixels 1:1.
  }

  // --- Drawing -----------------------------------------------------------

  // Route and style the stroke once at its start; width is set per segment
  // because pressure can vary it mid-stroke.
  function beginStrokeStyle() {
    mixingStroke = canMix && tool.mixing && !tool.erasing;
    strokeCtx = mixingStroke ? maskCtx : ctx;

    if (mixingStroke) {
      // Freeze the paper and start a fresh coverage mask for this stroke.
      snapCtx.clearRect(0, 0, snap.width, snap.height);
      snapCtx.drawImage(canvas, 0, 0);
      maskCtx.clearRect(0, 0, mask.width, mask.height);
      maskCtx.strokeStyle = "#000";
      maskCtx.fillStyle = "#000";
      strokeEngine = engine;
      strokeBrush = brush;
      strokeBrushRGB = brush.rgb;
    } else if (tool.erasing) {
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
    strokeCtx.lineWidth = p.w;
    strokeCtx.beginPath();
    strokeCtx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
    strokeCtx.fill();
    markDirty(p.x, p.y, p.x, p.y, p.w);
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
      strokeCtx.lineWidth = pts[1].w;
      strokeCtx.beginPath();
      strokeCtx.moveTo(pts[0].x, pts[0].y);
      strokeCtx.lineTo(m.x, m.y);
      strokeCtx.stroke();
      markDirty(
        Math.min(pts[0].x, pts[1].x),
        Math.min(pts[0].y, pts[1].y),
        Math.max(pts[0].x, pts[1].x),
        Math.max(pts[0].y, pts[1].y),
        pts[1].w
      );
      return;
    }

    const p0 = pts[n - 3];
    const p1 = pts[n - 2];
    const p2 = pts[n - 1];
    strokeCtx.lineWidth = p1.w;
    strokeCtx.beginPath();
    strokeCtx.moveTo(mid(p0, p1).x, mid(p0, p1).y);
    strokeCtx.quadraticCurveTo(p1.x, p1.y, mid(p1, p2).x, mid(p1, p2).y);
    strokeCtx.stroke();
    markDirty(
      Math.min(p0.x, p1.x, p2.x),
      Math.min(p0.y, p1.y, p2.y),
      Math.max(p0.x, p1.x, p2.x),
      Math.max(p0.y, p1.y, p2.y),
      p1.w
    );
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
      strokeCtx.lineWidth = p2.w;
      strokeCtx.beginPath();
      strokeCtx.moveTo(mid(p1, p2).x, mid(p1, p2).y);
      strokeCtx.lineTo(p2.x, p2.y);
      strokeCtx.stroke();
      markDirty(
        Math.min(p1.x, p2.x),
        Math.min(p1.y, p2.y),
        Math.max(p1.x, p2.x),
        Math.max(p1.y, p2.y),
        p2.w
      );
    }
    if (mixingStroke) {
      if (mixRaf) cancelAnimationFrame(mixRaf);
      mixRaf = 0;
      flushMix();
      mixingStroke = false;
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
        setBrush(tool.color);
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

  // Paint mixing — on by default, remembered like the theme. Only affects
  // strokes started after the switch; the picture itself is untouched.
  const mixBtn = document.getElementById("btn-mix");
  function applyMixing(on) {
    tool.mixing = on;
    mixBtn.textContent = on ? "Mix colours: on" : "Mix colours: off";
    try {
      localStorage.setItem("colour-mixing", on ? "on" : "off");
    } catch (_) {}
  }
  mixBtn.addEventListener("click", () => {
    applyMixing(!tool.mixing);
  });
  if (!canMix) mixBtn.hidden = true;

  // Mix style — "colour" (Mixbox: vivid, close to the swatch colours) vs
  // "paint" (spectral.js: softer, like actual paint). Only offered when both
  // engines loaded; a new brush is built so the change takes effect at once.
  const styleBtn = document.getElementById("btn-style");
  function applyStyle(style) {
    engine = style === "paint" ? "spectral" : "mixbox";
    styleBtn.textContent =
      style === "paint" ? "Mix style: paint" : "Mix style: colour";
    setBrush(tool.color);
    try {
      localStorage.setItem("colour-mix-style", style);
    } catch (_) {}
  }
  styleBtn.addEventListener("click", () => {
    applyStyle(engine === "mixbox" ? "paint" : "colour");
  });
  if (!(hasMixbox && hasSpectral)) styleBtn.hidden = true;

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
  document.addEventListener("dblclick", swallow);
  // Only swallow touch-moves over the canvas (to stop the page scrolling while
  // drawing). Swallowing them everywhere would cancel the native touch/pen
  // drag on the slider, so it could only be tapped, not slid.
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.target === canvas) e.preventDefault();
    },
    { passive: false }
  );

  // --- Boot --------------------------------------------------------------
  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem("colour-theme") || "light";
  } catch (_) {}
  applyTheme(savedTheme === "dark");

  let savedMixing = "on";
  try {
    savedMixing = localStorage.getItem("colour-mixing") || "on";
  } catch (_) {}
  applyMixing(savedMixing !== "off");

  let savedStyle = "colour";
  try {
    savedStyle = localStorage.getItem("colour-mix-style") || "colour";
  } catch (_) {}
  if (hasMixbox && hasSpectral) {
    applyStyle(savedStyle === "paint" ? "paint" : "colour");
  } else {
    setBrush(tool.color); // single engine — brush for whatever loaded
  }

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  resize();
})();
