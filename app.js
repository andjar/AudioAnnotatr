/* AudioAnnotatr - Browser-based audio waveform viewer and annotation tool */

(function () {
  "use strict";

  // ---------- Elements ----------
  const audioFileInput = document.getElementById("audioFileInput");
  const importJsonInput = document.getElementById("importJsonInput");
  const exportJsonButton = document.getElementById("exportJsonButton");
  const audioElement = document.getElementById("audioElement");
  const absoluteStartInput = document.getElementById("absoluteStartInput");
  const absoluteStartNowButton = document.getElementById("absoluteStartNowButton");
  const absoluteCurrentLabel = document.getElementById("absoluteCurrentLabel");
  const relativeTimeLabel = document.getElementById("relativeTimeLabel");
  const relativeDurationLabel = document.getElementById("relativeDurationLabel");
  const waveformCanvas = document.getElementById("waveformCanvas");
  const waveformContainer = document.getElementById("waveformContainer");
  const annotationTextInput = document.getElementById("annotationTextInput");
  const addAnnotationButton = document.getElementById("addAnnotationButton");
  const annotationsList = document.getElementById("annotationsList");
  const zoomSlider = document.getElementById("zoomSlider");
  const zoomLabel = document.getElementById("zoomLabel");
  const offsetSlider = document.getElementById("offsetSlider");
  const offsetLabel = document.getElementById("offsetLabel");

  // ---------- State ----------
  /** @type {AudioBuffer | null} */
  let decodedAudioBuffer = null;
  /** @type {string | null} */
  let audioObjectUrl = null;
  /** @type {Array<{ id: string, timeSeconds: number, label: string }>} */
  let annotations = [];
  /** @type {Date | null} */
  let absoluteStartDate = null;
  /** @type {string | null} */
  let audioFileName = null;

  let animationFrameId = null;
  let lastDrawnWidth = 0;
  let lastDrawnHeight = 0;
  let zoomFactor = 1; // 1 = whole duration, >1 zooms in
  let viewOffsetSeconds = 0; // start time of visible window

  // Axis layout
  const AXIS_TOP_HEIGHT = 22; // px, absolute axis
  const AXIS_BOTTOM_HEIGHT = 22; // px, relative axis
  const CANVAS_MIN_HEIGHT = 160; // css px

  const audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // ---------- Utilities ----------
  function formatRelativeTime(seconds) {
    if (!isFinite(seconds)) return "00:00.000";
    const sign = seconds < 0 ? "-" : "";
    const s = Math.abs(seconds);
    const minutes = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    const mm = String(minutes).padStart(2, "0");
    const ss = String(secs).padStart(2, "0");
    const mmm = String(ms).padStart(3, "0");
    return `${sign}${mm}:${ss}.${mmm}`;
  }

  function toISOStringLocal(date) {
    // Convert a Date to YYYY-MM-DDTHH:MM:SS for datetime-local input with seconds
    const pad = (n) => String(n).padStart(2, "0");
    const yyyy = date.getFullYear();
    const MM = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}`;
  }

  function parseDatetimeLocal(value) {
    // value like 2025-08-08T12:30:05 from input datetime-local (local time)
    if (!value) return null;
    const [datePart, timePart] = value.split("T");
    if (!datePart || !timePart) return null;
    const [y, m, d] = datePart.split("-").map((v) => parseInt(v, 10));
    const parts = timePart.split(":").map((v) => parseInt(v, 10));
    const hh = parts[0];
    const mm = parts[1];
    const ss = parts[2] ?? 0;
    if ([y, m, d, hh, mm, ss].some((n) => Number.isNaN(n))) return null;
    return new Date(y, m - 1, d, hh, mm, ss);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function generateId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function getDuration() {
    const d = Number.isFinite(audioElement.duration) ? audioElement.duration : null;
    return d && d > 0 ? d : decodedAudioBuffer?.duration ?? null;
  }

  function getCurrentTime() {
    return Number.isFinite(audioElement.currentTime) ? audioElement.currentTime : 0;
  }

  function relativeToAbsolute(dateStart, seconds) {
    if (!dateStart) return null;
    const t = new Date(dateStart.getTime() + Math.round(seconds * 1000));
    return t;
  }

  function formatAbsolute(date) {
    if (!date) return "—";
    return date.toLocaleString();
  }

  function computeNiceTickStep(durationSeconds, targetTickCount = 10) {
    if (!durationSeconds || durationSeconds <= 0) return 1;
    const raw = durationSeconds / targetTickCount;
    const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1200];
    for (let i = 0; i < niceSteps.length; i++) {
      if (niceSteps[i] >= raw) return niceSteps[i];
    }
    return 1800; // 30 minutes fallback
  }

  // ---------- Rendering ----------
  function setupHiDPICanvas(canvas, cssWidth, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function draw() {
    const cssWidth = Math.floor(waveformContainer.clientWidth - 20); // padding approx
    const cssHeight = CANVAS_MIN_HEIGHT;

    if (cssWidth <= 0) return;
    const ctx = setupHiDPICanvas(waveformCanvas, cssWidth, cssHeight);
    lastDrawnWidth = cssWidth;
    lastDrawnHeight = cssHeight;

    // Background
    ctx.fillStyle = "#0b0f1e";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const duration = getDuration();
    const axisTop = AXIS_TOP_HEIGHT;
    const axisBottom = AXIS_BOTTOM_HEIGHT;
    const plotX0 = 8;
    const plotX1 = cssWidth - 8;
    const plotY0 = axisTop + 10;
    const plotY1 = cssHeight - axisBottom - 10;
    const plotW = plotX1 - plotX0;
    const plotH = plotY1 - plotY0;
    const viewSpan = duration ? Math.max(0.001, duration / Math.max(1, zoomFactor)) : 0;
    const maxOffset = duration ? Math.max(0, duration - viewSpan) : 0;
    const viewStart = duration ? clamp(viewOffsetSeconds, 0, maxOffset) : 0;
    const viewEnd = duration ? viewStart + viewSpan : 0;

    // Grid
    ctx.strokeStyle = "#20263a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(plotX0, plotY0, plotW, plotH);
    ctx.stroke();

    // Waveform
    if (decodedAudioBuffer && duration) {
      drawWaveform(ctx, decodedAudioBuffer, plotX0, plotY0, plotW, plotH, viewStart, viewEnd);
    } else {
      // Empty placeholder
      ctx.fillStyle = "#2a2f45";
      ctx.fillRect(plotX0, plotY0, plotW, plotH);
      ctx.fillStyle = "#9aa0b8";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("Load an audio file to see its waveform", plotX0 + 10, plotY0 + 20);
    }

    // Ticks
    drawAxes(ctx, plotX0, plotY0, plotW, plotH, duration, viewStart, viewEnd);

    // Annotations
    drawAnnotations(ctx, plotX0, plotY0, plotW, plotH, duration, viewStart, viewEnd);

    // Playhead
    if (duration) {
      drawPlayhead(ctx, plotX0, plotY0, plotW, plotH, duration, getCurrentTime(), viewStart, viewEnd);
    }
  }

  function drawWaveform(ctx, buffer, x0, y0, w, h, viewStart, viewEnd) {
    const channelData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const startSample = Math.max(0, Math.floor(viewStart * sampleRate));
    const endSample = Math.min(channelData.length, Math.ceil(viewEnd * sampleRate));
    const windowSamples = Math.max(1, endSample - startSample);

    const midY = y0 + h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();

    ctx.fillStyle = "#121a33";
    ctx.fillRect(x0, y0, w, h);

    ctx.strokeStyle = "#69d2ff";
    ctx.lineWidth = 1;

    for (let px = 0; px < w; px++) {
      const s0 = startSample + Math.floor((px / w) * windowSamples);
      const s1 = startSample + Math.floor(((px + 1) / w) * windowSamples);
      const start = clamp(s0, 0, channelData.length - 1);
      const end = clamp(s1, start + 1, channelData.length);
      let min = 1.0;
      let max = -1.0;
      for (let i = start; i < end; i++) {
        const v = channelData[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yMin = midY + min * (h / 2 - 2);
      const yMax = midY + max * (h / 2 - 2);
      ctx.beginPath();
      ctx.moveTo(x0 + px, yMin);
      ctx.lineTo(x0 + px, yMax);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawAxes(ctx, x0, y0, w, h, duration, viewStart, viewEnd) {
    if (!duration) return;
    const topAxisY = y0 - 8;
    const bottomAxisY = y0 + h + 14;
    const viewSpan = Math.max(0.001, viewEnd - viewStart);
    const tickStep = computeNiceTickStep(viewSpan, 8);

    ctx.fillStyle = "#9aa0b8";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";

    // Relative axis (bottom)
    const startTick = Math.floor(viewStart / tickStep) * tickStep;
    for (let t = startTick; t <= viewEnd + 1e-6; t += tickStep) {
      if (t < viewStart - 1e-6) continue;
      const x = x0 + ((t - viewStart) / viewSpan) * w;
      ctx.strokeStyle = "#20263a";
      ctx.beginPath();
      ctx.moveTo(x, y0 + h);
      ctx.lineTo(x, y0 + h + 6);
      ctx.stroke();
      const label = formatRelativeTime(t);
      ctx.fillText(label, x + 4, bottomAxisY);
    }
    ctx.fillStyle = "#cfe8ff";
    ctx.fillText("Relative (mm:ss.ms)", x0, bottomAxisY + 18);

    // Absolute axis (top)
    if (absoluteStartDate) {
      ctx.fillStyle = "#9aa0b8";
      for (let t = startTick; t <= viewEnd + 1e-6; t += tickStep) {
        if (t < viewStart - 1e-6) continue;
        const x = x0 + ((t - viewStart) / viewSpan) * w;
        ctx.strokeStyle = "#20263a";
        ctx.beginPath();
        ctx.moveTo(x, y0 - 6);
        ctx.lineTo(x, y0);
        ctx.stroke();
        const abs = relativeToAbsolute(absoluteStartDate, t);
        const label = abs ? abs.toLocaleTimeString() : "";
        ctx.fillText(label, x + 4, topAxisY);
      }
      ctx.fillStyle = "#cfe8ff";
      ctx.fillText("Absolute", x0, topAxisY - 14);
    }
  }

  function drawAnnotations(ctx, x0, y0, w, h, duration, viewStart, viewEnd) {
    if (!annotations.length || !duration) return;
    const viewSpan = Math.max(0.001, viewEnd - viewStart);
    for (const ann of annotations) {
      if (ann.timeSeconds < viewStart || ann.timeSeconds > viewEnd) continue;
      const x = x0 + ((ann.timeSeconds - viewStart) / viewSpan) * w;
      // Marker line
      ctx.strokeStyle = "#8aff80";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();

      // Small label
      ctx.fillStyle = "#8aff80";
      ctx.font = "12px system-ui, sans-serif";
      const label = ann.label ? ` ${ann.label}` : "";
      ctx.fillText(`▲${label}`, x + 4, y0 + 12);
    }
  }

  function drawPlayhead(ctx, x0, y0, w, h, duration, currentTime, viewStart, viewEnd) {
    if (currentTime < viewStart || currentTime > viewEnd) return;
    const viewSpan = Math.max(0.001, viewEnd - viewStart);
    const x = x0 + ((clamp(currentTime, viewStart, viewEnd) - viewStart) / viewSpan) * w;
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---------- Interaction ----------
  function onResize() {
    updateZoomControls();
    draw();
  }

  function onTimeUpdate() {
    const duration = getDuration();
    const current = getCurrentTime();

    relativeTimeLabel.textContent = formatRelativeTime(current);
    relativeDurationLabel.textContent = formatRelativeTime(duration || 0);

    if (absoluteStartDate && Number.isFinite(current)) {
      const absNow = relativeToAbsolute(absoluteStartDate, current);
      absoluteCurrentLabel.textContent = formatAbsolute(absNow);
    } else {
      absoluteCurrentLabel.textContent = "—";
    }

    updateZoomControls();
    draw();
  }

  function startAnimation() {
    stopAnimation();
    const loop = () => {
      onTimeUpdate();
      animationFrameId = requestAnimationFrame(loop);
    };
    animationFrameId = requestAnimationFrame(loop);
  }
  function stopAnimation() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  function handleWaveformClick(ev) {
    const rect = waveformCanvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;

    const duration = getDuration();
    if (!duration || duration <= 0) return;

    const plotX0 = 8;
    const plotX1 = lastDrawnWidth - 8;
    const plotW = plotX1 - plotX0;
    const clampedX = clamp(x, plotX0, plotX1) - plotX0;
    const viewSpan = Math.max(0.001, duration / Math.max(1, zoomFactor));
    const maxOffset = Math.max(0, duration - viewSpan);
    const viewStart = clamp(viewOffsetSeconds, 0, maxOffset);
    const clickedSeconds = viewStart + (clampedX / plotW) * viewSpan;

    if (ev.shiftKey) {
      // Add annotation at clicked time
      const text = annotationTextInput.value.trim();
      addAnnotation(clickedSeconds, text);
    } else {
      // Seek
      audioElement.currentTime = clickedSeconds;
      audioElement.play().catch(() => {});
    }
  }

  function addAnnotation(timeSeconds, label) {
    if (!Number.isFinite(timeSeconds)) return;
    const ann = { id: generateId(), timeSeconds, label: label || "" };
    annotations.push(ann);
    annotations.sort((a, b) => a.timeSeconds - b.timeSeconds);
    renderAnnotationsList();
    updateExportButtonState();
    draw();
  }

  function editAnnotation(id) {
    const idx = annotations.findIndex((a) => a.id === id);
    if (idx === -1) return;
    const current = annotations[idx];
    const newLabel = prompt("Edit annotation text:", current.label ?? "");
    if (newLabel === null) return; // canceled
    const newTimeStr = prompt("Edit time in seconds (e.g. 12.345):", String(current.timeSeconds));
    if (newTimeStr === null) return;
    const newTime = parseFloat(newTimeStr);
    if (!Number.isFinite(newTime)) return;
    annotations[idx] = { ...current, label: newLabel, timeSeconds: newTime };
    annotations.sort((a, b) => a.timeSeconds - b.timeSeconds);
    renderAnnotationsList();
    draw();
  }

  function deleteAnnotation(id) {
    annotations = annotations.filter((a) => a.id !== id);
    renderAnnotationsList();
    updateExportButtonState();
    draw();
  }

  function jumpToAnnotation(id) {
    const ann = annotations.find((a) => a.id === id);
    if (!ann) return;
    audioElement.currentTime = clamp(ann.timeSeconds, 0, getDuration() || ann.timeSeconds);
    audioElement.play().catch(() => {});
  }

  function renderAnnotationsList() {
    annotationsList.innerHTML = "";
    const duration = getDuration() || 0;
    for (const ann of annotations) {
      const item = document.createElement("div");
      item.className = "annotation-item";

      const times = document.createElement("div");
      times.className = "annotation-times";
      const rel = document.createElement("div");
      rel.className = "rel";
      rel.textContent = formatRelativeTime(ann.timeSeconds);
      const abs = document.createElement("div");
      abs.className = "abs";
      if (absoluteStartDate) {
        abs.textContent = formatAbsolute(relativeToAbsolute(absoluteStartDate, ann.timeSeconds));
      } else {
        abs.textContent = "";
      }
      times.appendChild(rel);
      times.appendChild(abs);

      const text = document.createElement("div");
      text.className = "annotation-text";
      text.textContent = ann.label || "(no text)";

      const actions = document.createElement("div");
      actions.className = "annotation-actions";
      const btnGo = document.createElement("button");
      btnGo.className = "secondary";
      btnGo.textContent = "Go";
      btnGo.addEventListener("click", () => jumpToAnnotation(ann.id));
      const btnEdit = document.createElement("button");
      btnEdit.textContent = "Edit";
      btnEdit.addEventListener("click", () => editAnnotation(ann.id));
      const btnDel = document.createElement("button");
      btnDel.className = "danger";
      btnDel.textContent = "Delete";
      btnDel.addEventListener("click", () => deleteAnnotation(ann.id));
      actions.appendChild(btnGo);
      actions.appendChild(btnEdit);
      actions.appendChild(btnDel);

      item.appendChild(times);
      item.appendChild(text);
      // grid spans handled by CSS for responsive layout
      item.appendChild(actions);
      annotationsList.appendChild(item);
    }
  }

  function updateExportButtonState() {
    exportJsonButton.disabled = annotations.length === 0;
    addAnnotationButton.disabled = !getDuration();
  }

  function updateZoomControls() {
    const duration = getDuration();
    const hasDuration = !!duration && duration > 0;
    zoomSlider.disabled = !hasDuration;
    if (!hasDuration) {
      // Reset when no duration
      zoomSlider.value = String(zoomFactor);
      zoomLabel.textContent = `x${zoomFactor.toFixed(1)}`;
      offsetSlider.value = "0";
      offsetLabel.textContent = "0.00s";
      offsetSlider.disabled = true;
      return;
    }
    // Compute view window
    const viewSpan = Math.max(0.001, duration / Math.max(1, zoomFactor));
    const maxOffset = Math.max(0, duration - viewSpan);
    viewOffsetSeconds = clamp(viewOffsetSeconds, 0, maxOffset);
    // Sync zoom UI
    zoomSlider.value = String(zoomFactor);
    zoomLabel.textContent = `x${zoomFactor.toFixed(1)}`;
    // Sync offset UI
    offsetSlider.min = "0";
    offsetSlider.max = String(maxOffset);
    offsetSlider.step = "0.01";
    offsetSlider.value = String(viewOffsetSeconds.toFixed(2));
    offsetLabel.textContent = `${viewOffsetSeconds.toFixed(2)}s`;
    // Disable offset when there is nothing to pan
    offsetSlider.disabled = maxOffset <= 0.0009;
  }

  // ---------- File Loading ----------
  async function loadAudioFile(file) {
    if (!file) return;
    cleanupAudioUrl();

    audioFileName = file.name || null;
    const objectUrl = URL.createObjectURL(file);
    audioObjectUrl = objectUrl;
    audioElement.src = objectUrl;

    try {
      const arrayBuffer = await file.arrayBuffer();
      decodedAudioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      console.error("Failed to decode audio:", err);
      decodedAudioBuffer = null;
    }

    await whenMetadataLoaded(audioElement).catch(() => {});
    onTimeUpdate();
    updateZoomControls();
    draw();
    updateExportButtonState();
  }

  function whenMetadataLoaded(media) {
    return new Promise((resolve, reject) => {
      if (Number.isFinite(media.duration) && media.duration > 0) return resolve();
      const ok = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); resolve(); };
      const cleanup = () => {
        media.removeEventListener("loadedmetadata", ok);
        media.removeEventListener("error", fail);
      };
      media.addEventListener("loadedmetadata", ok, { once: true });
      media.addEventListener("error", fail, { once: true });
    });
  }

  function cleanupAudioUrl() {
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
  }

  // ---------- JSON Import/Export ----------
  function exportJson() {
    const payload = {
      schema: "audio-annotatr/v1",
      absoluteStart: absoluteStartDate ? absoluteStartDate.toISOString() : null,
      audioFileName: audioFileName || null,
      annotations: annotations.map((a) => ({ t: a.timeSeconds, label: a.label, meta: {} })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const name = (audioFileName ? audioFileName.replace(/\.[^.]+$/, "") : "annotations") + "-annotations.json";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function importJsonFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") throw new Error("Invalid JSON");
      if (data.schema && !String(data.schema).startsWith("audio-annotatr/")) {
        console.warn("Unknown schema:", data.schema);
      }

      const importedAnnotations = Array.isArray(data.annotations)
        ? data.annotations
            .map((it) => ({ id: generateId(), timeSeconds: Number(it.t) || 0, label: String(it.label || "") }))
            .sort((a, b) => a.timeSeconds - b.timeSeconds)
        : [];

      annotations = importedAnnotations;
      absoluteStartDate = data.absoluteStart ? new Date(data.absoluteStart) : null;
      if (absoluteStartDate) {
        absoluteStartInput.value = toISOStringLocal(absoluteStartDate);
      } else {
        absoluteStartInput.value = "";
      }

      renderAnnotationsList();
      updateExportButtonState();
      draw();
    } catch (err) {
      console.error("Failed to import JSON:", err);
      alert("Could not import JSON. See console for details.");
    }
  }

  // ---------- Event Wiring ----------
  audioFileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadAudioFile(file);
  });

  importJsonInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importJsonFile(file);
  });

  exportJsonButton.addEventListener("click", exportJson);

  addAnnotationButton.addEventListener("click", () => {
    const text = annotationTextInput.value.trim();
    addAnnotation(getCurrentTime(), text);
    annotationTextInput.value = "";
  });

  absoluteStartNowButton.addEventListener("click", () => {
    const now = new Date();
    absoluteStartDate = now;
    absoluteStartInput.value = toISOStringLocal(now);
    draw();
    renderAnnotationsList();
  });

  absoluteStartInput.addEventListener("change", () => {
    const parsed = parseDatetimeLocal(absoluteStartInput.value);
    absoluteStartDate = parsed;
    draw();
    renderAnnotationsList();
  });

  audioElement.addEventListener("timeupdate", onTimeUpdate);
  audioElement.addEventListener("loadedmetadata", onTimeUpdate);
  audioElement.addEventListener("play", startAnimation);
  audioElement.addEventListener("pause", stopAnimation);

  window.addEventListener("resize", onResize);

  waveformCanvas.addEventListener("click", handleWaveformClick);

  // Zoom and offset controls
  zoomSlider.addEventListener("input", () => {
    zoomFactor = Math.max(1, parseFloat(zoomSlider.value) || 1);
    updateZoomControls();
    draw();
  });
  offsetSlider.addEventListener("input", () => {
    const duration = getDuration() || 0;
    const viewSpan = duration ? Math.max(0.001, duration / Math.max(1, zoomFactor)) : 0;
    const maxOffset = Math.max(0, duration - viewSpan);
    viewOffsetSeconds = clamp(parseFloat(offsetSlider.value) || 0, 0, maxOffset);
    updateZoomControls();
    draw();
  });

  // Initial
  updateExportButtonState();
  updateZoomControls();
  draw();
})();


