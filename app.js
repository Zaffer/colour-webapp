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
   (paint this stroke lays down) : (paint already there). Strokes mix against a
   snapshot of the canvas taken when the first of them began, which keeps a
   stroke uniform instead of compounding with itself where segments overlap;
   lift and stroke again to mix another coat.

   Multi-touch: every pointer gets its own stroke, so a whole hand — or two
   children — can draw at once, each finger keeping the colour and size it
   started with. A pen takes over when it lands: touches are ignored while it
   is drawing or hovering, so a resting palm doesn't paint.

   Input model: a press does whatever is under it *now*, not what was under it
   when it landed. Drag along the swatches and each picks as you pass; carry on
   up onto the paper and the same press starts painting; come back down onto
   the slider and it sizes the pen. Nothing needs lifting to reach anything, so
   a hand that has found its grip never has to let go. See "Pointer routing".
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
    // Matches the paint-amount input's value in index.html, the way size does;
    // syncAmount() at boot reconciles the two.
    amount: 207,
    erasing: false,
    mixing: true,
  };

  // One stroke per pointer currently down, keyed by pointerId. Each remembers
  // the colour, size and routing it started with, so changing tools mid-draw
  // never rewrites a finger already on the paper. Ten is the physical limit of
  // two hands; the cap just stops a misbehaving device growing this without end.
  const MAX_STROKES = 10;
  const strokes = new Map();
  let dpr = 1;

  // --- Paint mixing ------------------------------------------------------

  // A "mix session" covers every mixing stroke whose time on the paper
  // overlaps. It owns the two shared buffers: `snap`, the paper as it was when
  // the first of them landed, and `mask`, the coverage of all of them. One
  // snapshot for the group is what stops concurrent strokes fighting over
  // shared pixels — a flush is (snapshot + total coverage) in, colour out, so
  // any pixel recomputes to the same answer no matter which stroke asks or how
  // often. Two consequences, both worth the two fixed buffers: a second coat
  // only mixes once every finger is up, and where two fingers cross at the same
  // instant the one that got there last simply covers, rather than mixing.
  let mixSession = false;
  let mixRaf = 0;

  // Pigment working forms (a Mixbox latent vector / a spectral.Color) for the
  // colours found in the mask, each with a small index so a mixed pixel can be
  // cached under a single integer key (see flushStroke). A stroke's interior
  // reads back as exactly the swatch colour, but partly-covered edge pixels
  // come back off-hue — the canvas stores colours premultiplied by alpha, and
  // dividing that back out at alpha 3/255 loses most of the precision — so the
  // table picks up a long tail of near-misses and is capped rather than grown
  // without end. 4096 keeps every index inside the exact-integer range.
  const PIGMENT_MAX = 4096;
  const pigments = new Map(); // packed sRGB -> { mix, i }

  // Mixed-pixel cache: real drawings have few distinct colours under a brush,
  // so almost every pixel is a repeat.
  const MIXQ = 255; // paint amounts quantised to 256 levels — the full alpha range
  const MIXR = MIXQ + 1; // cache-key radix; must track MIXQ or keys collide
  const mixCache = new Map();

  // What each later layer adds. A first pass lands at the stroke's paint amount;
  // passes over existing paint creep up by this much only, so 207 -> 223 -> 239
  // -> 255 is four passes instead of saturating on the second. Opacity only: the
  // pigment mix still weights by the full amount laid, so two crossing strokes go
  // half-and-half however faint the paper under them still reads.
  const LAYER_ADD = 16;

  // The paint amounts the slider can pick: whole LAYER_ADD steps down from full,
  // so 255 - n * LAYER_ADD. Every one of them builds up to land exactly on 255,
  // which is what picks 207 over a rounder 208 — 255 - 207 is 48, three whole
  // steps. It is also 13/16 of full measured against 255, where 208 measures
  // 13/16 of a 256th level alpha does not have. Sixteen levels; the faintest is
  // 15 rather than 0, since a pen that leaves no mark reads as a fault.
  const AMOUNT_STEP = LAYER_ADD;
  const AMOUNT_MAX = 255;
  const AMOUNT_LEVELS = 16;
  const AMOUNT_MIN = AMOUNT_MAX - (AMOUNT_LEVELS - 1) * AMOUNT_STEP; // 15
  const snapAmount = (v) =>
    AMOUNT_MAX -
    Math.min(
      AMOUNT_LEVELS - 1,
      Math.max(0, Math.round((AMOUNT_MAX - v) / AMOUNT_STEP))
    ) *
      AMOUNT_STEP;

  // Alpha at or below which a pixel counts as bare paper. What reads back from
  // a rim that faint is mostly premultiplied-alpha noise rather than a colour
  // (see the pigment table note above), so mixing against it tints the seam.
  // MIXQ at 64 levels used to round these to zero and skip them for free; at
  // 256 levels nothing rounds away, so the tolerance has to be explicit.
  const BARE_ALPHA = 2;

  function resetPigments() {
    pigments.clear();
    mixCache.clear(); // cached mixes are keyed by pigment index
  }

  function pigmentFor(key, r, g, b) {
    let p = pigments.get(key);
    if (!p) {
      if (pigments.size >= PIGMENT_MAX) resetPigments();
      p = {
        mix:
          engine === "mixbox"
            ? mixbox.rgbToLatent(r, g, b)
            : new spectral.Color([r, g, b]),
        i: pigments.size,
      };
      pigments.set(key, p);
    }
    return p;
  }

  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // Mix `laid` parts of the pigment `pig` into `had` parts of the colour
  // already on the pixel; returns sRGB ints.
  function mixPaint(r, g, b, pig, had, laid) {
    if (engine === "mixbox") {
      const zA = mixbox.rgbToLatent(r, g, b);
      const zB = pig.mix;
      const t = laid / (had + laid);
      const z = new Array(mixbox.LATENT_SIZE);
      for (let i = 0; i < z.length; i++) z[i] = zA[i] + (zB[i] - zA[i]) * t;
      return mixbox.latentToRgb(z); // already clamped ints
    }
    const mixed = spectral.mix(
      [new spectral.Color([r, g, b]), had],
      [pig.mix, laid]
    ).sRGB;
    return [clamp255(mixed[0]), clamp255(mixed[1]), clamp255(mixed[2])];
  }

  // Freeze the paper and start a fresh mask for a new group of mixing strokes.
  function beginMixSession() {
    snapCtx.setTransform(1, 0, 0, 1, 0, 0); // copy device pixels 1:1
    snapCtx.globalCompositeOperation = "source-over";
    snapCtx.clearRect(0, 0, snap.width, snap.height);
    snapCtx.drawImage(canvas, 0, 0);
    snapCtx.setTransform(dpr, 0, 0, dpr, 0, 0); // back to CSS px for mirroring
    maskCtx.clearRect(0, 0, mask.width, mask.height);
    mixSession = true;
  }

  // The session lasts as long as one of its strokes is still on the paper.
  function endMixSessionIfIdle() {
    for (const s of strokes.values()) if (s.mixing) return;
    mixSession = false;
  }

  // Each stroke tracks its own dirty region, so two fingers at opposite corners
  // stay two small composites rather than one screen-sized one.
  function markDirty(s, x0, y0, x1, y1, w) {
    if (!s.mixing) return;
    const pad = w / 2 + 2; // half the pen plus antialiasing slack
    x0 -= pad;
    y0 -= pad;
    x1 += pad;
    y1 += pad;
    const d = s.dirty;
    if (!d) {
      s.dirty = { x0, y0, x1, y1 };
    } else {
      if (x0 < d.x0) d.x0 = x0;
      if (y0 < d.y0) d.y0 = y0;
      if (x1 > d.x1) d.x1 = x1;
      if (y1 > d.y1) d.y1 = y1;
    }
    if (!mixRaf) mixRaf = requestAnimationFrame(flushMix);
  }

  function flushMix() {
    mixRaf = 0;
    for (const s of strokes.values()) flushStroke(s);
  }

  // Composite a stroke's region onto the paper: every pixel the mask covers
  // gets its pigment (the mask's RGB) mixed into the paint that was already
  // there (the snapshot), weighted by how much of each. Runs at most once per
  // frame, over just the region that stroke touched since the last flush.
  function flushStroke(s) {
    const r = s.dirty;
    s.dirty = null;
    if (!r) return;

    const x = Math.max(0, Math.floor(r.x0 * dpr));
    const y = Math.max(0, Math.floor(r.y0 * dpr));
    const x2 = Math.min(canvas.width, Math.ceil(r.x1 * dpr));
    const y2 = Math.min(canvas.height, Math.ceil(r.y1 * dpr));
    if (x >= x2 || y >= y2) return;

    const cov = maskCtx.getImageData(x, y, x2 - x, y2 - y).data;
    const img = snapCtx.getImageData(x, y, x2 - x, y2 - y);
    const px = img.data;

    // The stroke's own paint amount, captured when it started. The mask is shared
    // between concurrent strokes, so two fingers drawing at different amounts
    // resolve per dirty region rather than per pixel — the same last-one-wins
    // approximation the mask already makes where two strokes cross at once.
    const scale = s.amount / AMOUNT_MAX;

    for (let i = 0; i < px.length; i += 4) {
      // Coverage scaled by the paint amount. Scaling here rather than by
      // drawing the mask at reduced alpha keeps a stroke even: the mask is
      // built from overlapping dabs, which would each composite again and
      // darken every overlap.
      const coverage = cov[i + 3] / 255;
      const laid = coverage * scale;
      if (laid === 0) continue;
      const had = px[i + 3] / 255; // paint that was already on the paper

      const qLaid = Math.round(laid * MIXQ);
      const qHad = Math.round(had * MIXQ);

      if (px[i + 3] <= BARE_ALPHA) {
        // Bare paper: the brush colour goes down as-is.
        px[i] = cov[i];
        px[i + 1] = cov[i + 1];
        px[i + 2] = cov[i + 2];
      } else if (qLaid > 0) {
        const pk = (cov[i] << 16) | (cov[i + 1] << 8) | cov[i + 2];
        const pig = pigmentFor(pk, cov[i], cov[i + 1], cov[i + 2]);
        // Packed as (pigment, colour, qHad, qLaid) in base MIXR. The pigment
        // and colour fields together stay under 2^36, so with MIXR at 256 the
        // key tops out just under 2^52 — inside the exact-integer range, with
        // room to spare. MIXR above 362 would silently overflow it.
        const key =
          ((pig.i * 0x1000000 +
            ((px[i] << 16) | (px[i + 1] << 8) | px[i + 2])) *
            MIXR +
            qHad) *
            MIXR +
          qLaid;
        let out = mixCache.get(key);
        if (!out) {
          out = mixPaint(
            px[i],
            px[i + 1],
            px[i + 2],
            pig,
            qHad / MIXQ,
            qLaid / MIXQ
          );
          if (mixCache.size > 100000) mixCache.clear();
          mixCache.set(key, out);
        }
        px[i] = out[0];
        px[i + 1] = out[1];
        px[i + 2] = out[2];
      }
      // A pass always lays at least its own paint amount, and only creeps by
      // LAYER_ADD where that would be going backwards — LAYER_ADD throttles
      // building up past the paint amount, it must never hold a pixel below it.
      // Taking the increment alone stranded the faint rim of paint underneath
      // at rim + 16 while the solid parts either side reached 208 and 224, and
      // that translucent seam was a white line tracing every buried edge.
      //
      // `px` is the frozen session snapshot rather than the live canvas, which
      // keeps this a pure function of (baseline alpha, coverage): the repeated
      // flushes a stroke makes while being drawn recompute one value instead of
      // stacking an increment per frame. Coverage scales both terms so
      // anti-aliased rims stay soft.
      const want = laid * 255; // what this pass lays on bare paper
      const step = px[i + 3] + LAYER_ADD * coverage; // creep past what is there
      px[i + 3] = Math.min(255, Math.round(Math.max(want, step)));
    }

    ctx.putImageData(img, x, y);
  }

  // End a stroke where it is, keeping what it drew (pointer lost, palm
  // rejected, window resized). Pointer capture is deliberately left alone: it
  // belongs to the press, which outlives any one stroke — a finger that leaves
  // the paper for a swatch ends its stroke but must keep reporting to us.
  function dropStroke(id) {
    const s = strokes.get(id);
    if (!s) return;
    strokes.delete(id);
    if (s.mixing) flushStroke(s);
    endMixSessionIfIdle();
  }

  function dropAllStrokes() {
    for (const id of [...strokes.keys()]) dropStroke(id);
    if (mixRaf) cancelAnimationFrame(mixRaf);
    mixRaf = 0;
  }

  // --- Canvas sizing -----------------------------------------------------
  // Device-pixel buffer for crisp strokes. On resize we redraw the previous
  // bitmap 1:1 (no scaling) so shrinking then growing restores exact pixels
  // instead of blurring them.

  function resize() {
    const nextDpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(window.innerWidth * nextDpr);
    const h = Math.round(window.innerHeight * nextDpr);
    if (canvas.width === w && canvas.height === h) return;

    // Resizing swaps the buffers out from under any in-progress stroke. Flush
    // them at the old scale before adopting the new one.
    dropAllStrokes();
    dpr = nextDpr;

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
    // snapCtx is set to CSS px too — direct strokes mirror themselves into it
    // (see paintTargets). The 1:1 snapshot copy sets identity for itself.
    snapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    snapCtx.lineCap = "round";
    snapCtx.lineJoin = "round";
  }

  // --- Drawing -----------------------------------------------------------

  // The contexts a stroke paints into, styled and ready. Mixing strokes paint
  // the shared mask in their own colour: its alpha says how much paint they
  // laid, its RGB which pigment, which is how one mask can carry several
  // fingers at once. Everything else paints the canvas directly — and mirrors
  // into the snapshot while a mix session is live, so an eraser or a plain
  // stroke isn't undone by a sibling stroke compositing over the same pixels.
  const targets = []; // reused; nothing calls this re-entrantly
  function paintTargets(s) {
    targets.length = 0;
    if (s.mixing) {
      maskCtx.strokeStyle = maskCtx.fillStyle = s.color;
      targets.push(maskCtx);
      return targets;
    }
    const op = s.erasing ? "destination-out" : "source-over";
    const paint = s.erasing ? "#000" : s.color;
    ctx.globalCompositeOperation = op;
    ctx.strokeStyle = ctx.fillStyle = paint;
    targets.push(ctx);
    if (mixSession) {
      snapCtx.globalCompositeOperation = op;
      snapCtx.strokeStyle = snapCtx.fillStyle = paint;
      targets.push(snapCtx);
    }
    return targets;
  }

  // S Pen (and other real styli) report 0..1 pressure. Map it to width for a
  // natural, tapering line. Touch/mouse have no useful pressure, so they draw
  // at the stroke's size flat. The size is the stroke's own, not the slider's:
  // dragging the slider with one finger mustn't reshape another's line.
  function widthFor(s, e) {
    if (e.pointerType === "pen" && e.pressure > 0) {
      return s.size * (0.35 + 0.9 * e.pressure);
    }
    return s.size;
  }

  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function dot(s, p) {
    for (const c of paintTargets(s)) {
      c.lineWidth = p.w;
      c.beginPath();
      c.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
      c.fill();
    }
    markDirty(s, p.x, p.y, p.x, p.y, p.w);
  }

  // Draw the newest smooth segment of one stroke. We route the curve through
  // the midpoints between sample points, using each sample as a quadratic
  // control point. Consecutive segments meet at those midpoints, so the whole
  // stroke is continuous and smooth even when samples are sparse (fast moves).
  function drawSegment(s) {
    const pts = s.pts;
    const n = pts.length;
    if (n < 2) return;

    if (n === 2) {
      // First segment: from the start point to the first midpoint.
      const m = mid(pts[0], pts[1]);
      for (const c of paintTargets(s)) {
        c.lineWidth = pts[1].w;
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        c.lineTo(m.x, m.y);
        c.stroke();
      }
      markDirty(
        s,
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
    const from = mid(p0, p1);
    const to = mid(p1, p2);
    for (const c of paintTargets(s)) {
      c.lineWidth = p1.w;
      c.beginPath();
      c.moveTo(from.x, from.y);
      c.quadraticCurveTo(p1.x, p1.y, to.x, to.y);
      c.stroke();
    }
    markDirty(
      s,
      Math.min(p0.x, p1.x, p2.x),
      Math.min(p0.y, p1.y, p2.y),
      Math.max(p0.x, p1.x, p2.x),
      Math.max(p0.y, p1.y, p2.y),
      p1.w
    );
  }

  // --- Pointer handling --------------------------------------------------

  // Palm rejection. A pen on the glass means a hand is resting on it too, so
  // while one is drawing — or hovering just above — touches are not drawing
  // tools. The grace window covers the gaps between pen strokes, when the hand
  // stays put but the tip is out of range.
  const PEN_GRACE = 400; // ms
  let lastPen = -Infinity;
  const penInUse = (t) => t - lastPen < PEN_GRACE;

  // Put a stroke under a pointer, starting at wherever that pointer is now.
  // Called both when a press lands on the paper and when a press that began on
  // the toolbar arrives there mid-drag, so leaving the toolbar starts painting
  // from the edge of it rather than trailing a line out from under the panel.
  function beginStroke(e) {
    if (strokes.size >= MAX_STROKES) return;

    const s = {
      pts: [],
      dirty: null,
      touch: e.pointerType === "touch",
      // Tool settings are captured now: tapping a swatch with another finger
      // starts a new colour rather than repainting this stroke. It is also what
      // makes drag-to-select read right — pass over blue on the way back to the
      // paper and the next stroke is blue, while the one you already drew stays
      // the colour you drew it in.
      color: tool.color,
      size: tool.size,
      amount: tool.amount,
      erasing: tool.erasing,
      mixing: canMix && tool.mixing && !tool.erasing,
    };
    if (s.mixing && !mixSession) beginMixSession();
    strokes.set(e.pointerId, s);

    s.pts.push({ x: e.clientX, y: e.clientY, w: widthFor(s, e) });
    dot(s, s.pts[0]); // a tap leaves a dot
  }

  function extendStroke(s, e) {
    // Coalesced events expose every sub-frame sample the OS buffered — the
    // single biggest win for smoothness on fast strokes. Fall back to the
    // event itself when unavailable.
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const events = coalesced && coalesced.length ? coalesced : [e];
    for (const ev of events) {
      s.pts.push({ x: ev.clientX, y: ev.clientY, w: widthFor(s, ev) });
      drawSegment(s);
    }
  }

  // Close a stroke off where it stands, keeping what it drew. Also how a stroke
  // ends when its press wanders off the paper onto a control: the tail closes at
  // the last point on the paper, so no paint is laid under the toolbar.
  function finishStroke(id) {
    const s = strokes.get(id);
    if (!s) return;
    // Close the tail: connect the last midpoint to the final point.
    const pts = s.pts;
    const n = pts.length;
    if (n >= 2) {
      const p1 = pts[n - 2];
      const p2 = pts[n - 1];
      const m = mid(p1, p2);
      for (const c of paintTargets(s)) {
        c.lineWidth = p2.w;
        c.beginPath();
        c.moveTo(m.x, m.y);
        c.lineTo(p2.x, p2.y);
        c.stroke();
      }
      markDirty(
        s,
        Math.min(p1.x, p2.x),
        Math.min(p1.y, p2.y),
        Math.max(p1.x, p2.x),
        Math.max(p1.y, p2.y),
        p2.w
      );
    }
    dropStroke(id); // flushes what this stroke still owes
  }

  // --- Tool selection ----------------------------------------------------

  const swatches = document.querySelectorAll(".swatch");
  let activeSwatch = document.querySelector(".swatch.is-active");

  // Idempotent: the router calls this on every move that is over a swatch, and
  // a drag sits over one swatch for many frames.
  function selectSwatch(btn) {
    if (btn === activeSwatch) return;
    activeSwatch = btn;
    swatches.forEach((b) => {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", String(on));
    });

    if (btn.hasAttribute("data-eraser")) {
      tool.erasing = true;
    } else {
      tool.erasing = false;
      tool.color = btn.dataset.color;
    }
    syncAmountUi(); // the knob's disc is in the colour, so it follows it
  }

  // Pointers are routed (see below), so this is only for keyboard and assistive
  // tech, where a swatch is just a radio button.
  swatches.forEach((btn) => btn.addEventListener("click", () => selectSwatch(btn)));

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

  // A press never reaches the range input (it is captured elsewhere — see
  // "Pointer routing"), so the value comes straight from the pointer's x. The
  // native thumb is 1px wide, which is what makes this a plain linear map
  // across the track and keeps our knob's centre on the rims at either end.
  function setSizeFromPointer(x) {
    const r = sizeInput.getBoundingClientRect();
    if (!r.width) return;
    const min = Number(sizeInput.min);
    const max = Number(sizeInput.max);
    const t = Math.min(1, Math.max(0, (x - r.left) / r.width));
    const v = Math.round(min + t * (max - min));
    if (v === Number(sizeInput.value)) return;
    sizeInput.value = v;
    syncSize();
  }

  // Paint amount is the slider's second axis: drag up for more paint, down for
  // less, a step at a time. It has no track of its own — the wedge and the knob
  // show where it stands, and the input below exists for the keyboard.
  const amountInput = document.getElementById("amount");
  const slider = document.querySelector(".slider");

  // Two readouts of one number, both inheriting it from .slider: the wedge fills
  // from the bottom like a meter, in a neutral, and the knob's disc previews the
  // mark it will make — the colour at this amount, at the pen's size (see
  // syncSize). Only the knob carries the colour; the meter is level alone.
  function syncAmountUi() {
    slider.style.setProperty("--amt", (tool.amount / AMOUNT_MAX).toFixed(3));
    slider.style.setProperty(
      "--ink-c",
      tool.erasing ? "transparent" : tool.color
    );
  }

  function syncAmount() {
    tool.amount = snapAmount(Number(amountInput.value));
    syncAmountUi();
    try {
      localStorage.setItem("colour-amount", String(tool.amount));
    } catch (_) {}
  }
  amountInput.addEventListener("input", syncAmount);

  function setAmount(v) {
    const next = snapAmount(v);
    if (next === tool.amount) return;
    amountInput.value = next;
    syncAmount();
  }

  // How far the pointer travels per step. The slider is 68px tall and there are
  // sixteen levels, so one pass covers about five of them and the full range
  // takes a few — which is the price of keeping the gesture inside the slider,
  // where leaving it has to go on meaning what it already means.
  const AMOUNT_PX = 12;

  // Relative, not absolute: x already sets the size from wherever the pointer
  // lands, and if y did the same every tap on the track would fling the paint
  // amount to whatever height the finger happened to touch. So the first move
  // only fixes a reference, and steps come from travel away from it. The
  // remainder is carried rather than dropped, so climbing and descending cost
  // exactly the same distance.
  function nudgeAmount(e) {
    const sess = sessions.get(e.pointerId);
    if (!sess) return;
    if (sess.ay == null) {
      sess.ay = e.clientY;
      return;
    }
    const steps = Math.trunc((sess.ay - e.clientY) / AMOUNT_PX); // up is more
    if (!steps) return;
    sess.ay -= steps * AMOUNT_PX;
    setAmount(tool.amount + steps * AMOUNT_STEP);
  }

  // --- Stowing the toolbar -----------------------------------------------

  // The panel rides on a translateY stacked on the CSS that centres it, so its
  // laid-out position stays the "home" it returns to. Drag the handle and the
  // panel tracks your finger; let go and it settles to whichever end it is
  // nearest — or, on a flick, whichever way you threw it. Stowed, it sits below
  // the bottom edge with only the handle poking up.

  const toolbar = document.getElementById("toolbar");
  const handle = document.getElementById("tb-handle");
  const colorsRow = document.querySelector(".colors");

  const TAP_SLOP = 6; // a press that moves less than this is a tap, not a drag
  const FLICK = 0.35; // px/ms — past this the throw decides, not the position
  const FLICK_STALE = 120; // ms — a throw older than this is not a throw

  let shift = 0; // current translateY, px
  let stowed = false;

  // What is left on screen when stowed: everything above the colours, which is
  // the handle and its padding. Taking it from the row's own offset rather than
  // a constant keeps the swatches exactly, and only just, off the bottom edge
  // however the panel's spacing is restyled.
  const peek = () => colorsRow.offsetTop;

  // Sliding the panel by its own height plus its bottom gap would put its top
  // edge exactly on the safe-area line, so stopping `peek` short of that leaves
  // the handle showing above it. The inset cancels out of that sum, which is
  // why it is nowhere in here.
  function stowShift() {
    const gap = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--tb-gap")
    );
    return Math.max(0, toolbar.offsetHeight + (gap || 0) - peek());
  }

  function setShift(px, animate) {
    shift = px;
    toolbar.classList.toggle("is-settling", !!animate);
    toolbar.style.setProperty("--tb-shift", px.toFixed(1) + "px");
  }

  function setStowed(on, animate) {
    stowed = on;
    setShift(on ? stowShift() : 0, animate);
    handle.setAttribute("aria-label", on ? "Show tools" : "Hide tools");
    handle.setAttribute("aria-expanded", String(!on));
  }

  // Where the panel actually is on screen right now. Mid-settle that is not
  // `shift` (already set to the target), and grabbing it then must pick it up
  // where it looks, not where it is heading.
  function visualShift() {
    if (!toolbar.classList.contains("is-settling")) return shift;
    try {
      return new DOMMatrixReadOnly(getComputedStyle(toolbar).transform).m42;
    } catch (_) {
      return shift;
    }
  }

  // One drag at a time: a second finger landing on the handle would otherwise
  // fight the first over the same translate. Asked of the live sessions rather
  // than tracked in a flag of its own, so there is no second piece of state to
  // fall out of step and wedge the handle if a press ever goes missing.
  function dragActive() {
    for (const s of sessions.values()) if (s.drag) return true;
    return false;
  }

  function beginDrag(e) {
    toolbar.classList.remove("is-settling");
    toolbar.classList.add("is-dragging");
    return {
      from: visualShift(),
      y0: e.clientY,
      y: e.clientY,
      t: e.timeStamp,
      v: 0,
      moved: 0,
    };
  }

  function moveDrag(d, e) {
    const dt = e.timeStamp - d.t;
    if (dt > 0) d.v = (e.clientY - d.y) / dt;
    d.y = e.clientY;
    d.t = e.timeStamp;
    const dy = e.clientY - d.y0;
    if (Math.abs(dy) > d.moved) d.moved = Math.abs(dy);
    setShift(Math.min(stowShift(), Math.max(0, d.from + dy)), false);
  }

  function endDrag(d) {
    toolbar.classList.remove("is-dragging");
    // Never really moved: that was a tap on the handle, so just toggle.
    if (d.moved < TAP_SLOP) {
      setStowed(!stowed, true);
      return;
    }
    // A throw only counts if the finger was still moving as it left. Drag the
    // panel somewhere, hold it there a moment and let go, and it settles from
    // where you parked it rather than from where you were once heading — which
    // is how a slow drag into position has to behave. Event timestamps share
    // performance.now()'s clock, so this measures the pause before the lift.
    const threw =
      Math.abs(d.v) > FLICK && performance.now() - d.t < FLICK_STALE;
    if (threw) setStowed(d.v > 0, true);
    else setStowed(shift > stowShift() / 2, true);
  }

  // Leaving the class on would animate the next drag's first frame.
  toolbar.addEventListener("transitionend", (e) => {
    if (e.propertyName === "transform") toolbar.classList.remove("is-settling");
  });

  // Pointers are routed (see below), so the handle never sees a click of its
  // own; this is the keyboard and assistive-tech path.
  handle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      setStowed(!stowed, true);
    }
  });

  // A stowed panel is positioned from its own height and the viewport, both of
  // which a rotation changes.
  function reflowToolbar() {
    if (stowed) setShift(stowShift(), false);
  }

  // --- Pointer routing ---------------------------------------------------

  // One held press drives the whole app. Every pointer that goes down opens a
  // session that lasts until it lifts, and on each move we ask what is under it
  // *now* — swatch, slider, or paper — and do that thing. Wander from red to
  // green and the colour follows your finger; carry on up onto the paper and
  // the same press starts painting; come back down onto blue and keep going.
  //
  // The settings menu is the one thing left out. Its items are one-shot and one
  // of them throws the picture away, so they stay tap-only: a press that
  // wanders over the menu does nothing at all, and a press that starts there
  // never opens a session, leaving the buttons to behave like buttons.
  //
  // A press has to keep reporting to us after it leaves whatever it landed on,
  // so each session captures its pointer to the canvas and we hit-test by hand.
  // That is also why the slider is driven from the pointer's x: with the pointer
  // captured, the range input never sees a drag of its own to act on.

  const sessions = new Map(); // pointerId -> { touch }

  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { kind: "paper" }; // off the top of the screen, say
    if (el.closest("#settings")) return { kind: "settings" };
    const swatch = el.closest(".swatch");
    if (swatch) return { kind: "swatch", el: swatch };
    if (el.closest(".slider")) return { kind: "slider" };
    if (el.closest(".tb-handle")) return { kind: "handle" };
    // Bare panel: no control here, but the paper behind it is covered.
    if (el.closest(".toolbar")) return { kind: "panel" };
    return { kind: "paper" };
  }

  // Do whatever is under the pointer. Anything that isn't paper ends the stroke
  // first, so crossing the toolbar breaks the line instead of drawing under it.
  // The handle is deliberately not in here: dragging the panel is a gesture
  // owned by the press that started on it, not something a press picks up by
  // wandering across — so a finger on its way somewhere else just breaks its
  // stroke, exactly as the bare panel does.
  function act(e, hit) {
    // The vertical axis only counts while the pointer is on the slider. Anywhere
    // else drops the reference point, so a press that wanders off to pick a
    // colour and comes back starts stepping again from where it re-enters
    // instead of jumping by however far it travelled in between.
    if (hit.kind !== "slider") {
      const sess = sessions.get(e.pointerId);
      if (sess) sess.ay = null;
    }
    if (hit.kind === "paper") {
      const s = strokes.get(e.pointerId);
      if (s) extendStroke(s, e);
      // No stroke yet: this press either just landed, or is arriving from the
      // toolbar. Either way it starts here — the trip across the panel is not
      // part of the line, so its buffered samples are dropped with it.
      else beginStroke(e);
      return;
    }
    finishStroke(e.pointerId);
    if (hit.kind === "swatch") selectSwatch(hit.el);
    else if (hit.kind === "slider") {
      setSizeFromPointer(e.clientX);
      nudgeAmount(e);
    }
  }

  function endSession(id, keep) {
    const sess = sessions.get(id);
    if (!sess) return;
    sessions.delete(id);
    if (sess.drag) endDrag(sess.drag); // settles the panel where it was let go
    else if (keep) finishStroke(id);
    else dropStroke(id);
    try {
      canvas.releasePointerCapture(id);
    } catch (_) {}
  }

  function onPointerDown(e) {
    if (sessions.has(e.pointerId)) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit.kind === "settings") return;

    if (e.pointerType === "pen") {
      lastPen = e.timeStamp;
      // Anything a palm already started stops here — including a swatch it was
      // resting on, which must not go on picking colours under the drawing hand.
      for (const [id, sess] of sessions) if (sess.touch) endSession(id, true);
    } else if (e.pointerType === "touch" && penInUse(e.timeStamp)) {
      return;
    }

    const sess = { touch: e.pointerType === "touch", drag: null };
    sessions.set(e.pointerId, sess);
    // Capture keeps this press reporting to us wherever it travels, and takes it
    // away from the range input so there is no native drag to fight. It is also
    // what lets a handle drag carry on once the panel has slid out from under
    // the finger that is moving it.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {}
    if (hit.kind === "handle" && !dragActive()) sess.drag = beginDrag(e);
    else act(e, hit);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (e.pointerType === "pen") lastPen = e.timeStamp; // hovering counts
    const sess = sessions.get(e.pointerId);
    if (!sess) return;
    if (sess.drag) moveDrag(sess.drag, e);
    else act(e, hitTest(e.clientX, e.clientY));
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (e.pointerType === "pen") lastPen = e.timeStamp;
    endSession(e.pointerId, true);
  }

  // On the document: a captured press is retargeted to the canvas and bubbles
  // up here anyway, and one whose capture never took still bubbles from
  // whatever it happens to be over.
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("pointercancel", onPointerUp);
  // If the OS takes a pointer away mid-press we stop hearing about it; without
  // this the session would sit in the map forever, holding the mix session open.
  canvas.addEventListener("lostpointercapture", (e) =>
    endSession(e.pointerId, true)
  );
  // Switching away mid-stroke never sends a pointerup.
  window.addEventListener("blur", () => {
    for (const id of [...sessions.keys()]) endSession(id, true);
  });

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
  // engines loaded; the pigment tables are dropped so the change takes effect
  // at once rather than replaying the old engine's cached mixes.
  const styleBtn = document.getElementById("btn-style");
  function applyStyle(style) {
    engine = style === "paint" ? "spectral" : "mixbox";
    styleBtn.textContent =
      style === "paint" ? "Mix style: paint" : "Mix style: colour";
    resetPigments();
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
    flushMix(); // include the frame a still-moving finger hasn't composited yet
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
      // A finger still on the paper would composite its snapshot — the picture
      // we just cleared — straight back onto it.
      dropAllStrokes();
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
  // Swallow touch-moves everywhere but the settings menu. Outside it every
  // drag is ours now — the slider included, which we drive ourselves — so
  // there is no native gesture left worth keeping, and letting one through
  // would only scroll the page out from under a drawing finger.
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!(e.target.closest && e.target.closest("#settings")))
        e.preventDefault();
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

  let savedAmount = 0;
  try {
    savedAmount = Number(localStorage.getItem("colour-amount")) || 0;
  } catch (_) {}
  if (savedAmount) amountInput.value = snapAmount(savedAmount);
  syncAmount(); // also paints the knob for the first time

  let savedStyle = "colour";
  try {
    savedStyle = localStorage.getItem("colour-mix-style") || "colour";
  } catch (_) {}
  // With only one engine loaded there is nothing to choose: `engine` is already
  // whichever of the two turned up.
  if (hasMixbox && hasSpectral) {
    applyStyle(savedStyle === "paint" ? "paint" : "colour");
  }

  function relayout() {
    resize();
    reflowToolbar();
  }
  window.addEventListener("resize", relayout);
  window.addEventListener("orientationchange", relayout);
  resize();
})();
