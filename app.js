"use strict";

const canvas = document.getElementById("canvas");
const overlay = document.getElementById("overlay");
const workspace = document.getElementById("workspace");
const viewport = document.getElementById("viewport");
const emptyState = document.getElementById("emptyState");
const layersEl = document.getElementById("layers");
const toolOptions = document.getElementById("toolOptions");
const fileInput = document.getElementById("fileInput");
const zoomLabel = document.getElementById("zoomLabel");

const ctx = canvas.getContext("2d", { willReadFrequently: true });
const overlayCtx = overlay.getContext("2d");

const state = {
  document: null,
  layers: [],
  selectedLayerId: null,
  tool: "move",
  zoom: 1,
  panX: 0,
  panY: 0,
  brushSize: 24,
  brushOpacity: 1,
  brushColor: "#ffffff",
  isDrawing: false,
  lastPoint: null,
  isPanning: false,
  panStart: null,
  selection: null,
  selectionMask: null,
  selectionMode: "new",
  isSelecting: false,
  selectionStart: null,
  marchingOffset: 0,
  history: [],
  historyIndex: -1,
  maskEditing: false,
  isMovingLayer: false,
  moveStart: null,
  layerDragId: null
};

function createLayer(name, width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return {
    id: crypto.randomUUID(),
    name,
    canvas: c,
    mask: null,
    x: 0,
    y: 0,
    opacity: 1,
    visible: true,
    locked: false
  };
}

function createMask(width, height) {
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(0, 0, width, height);
  return mask;
}

function createDocument(width, height, importedImage = null, fileName = null) {
  state.document = { width, height };
  state.layers = [];
  state.selection = null;
  state.maskEditing = false;
  state.history = [];
  state.historyIndex = -1;

  if (importedImage) {
    const imageLayer = createLayer(fileName || "Image", width, height);
    imageLayer.canvas.getContext("2d").drawImage(importedImage, 0, 0, width, height);
    state.layers.push(imageLayer);
    state.selectedLayerId = imageLayer.id;
  } else {
    const background = createLayer("Background", width, height);
    const bctx = background.canvas.getContext("2d");
    bctx.fillStyle = "#ffffff";
    bctx.fillRect(0, 0, width, height);

    const paint = createLayer("Layer 1", width, height);
    state.layers.push(background, paint);
    state.selectedLayerId = paint.id;
  }

  canvas.width = width;
  canvas.height = height;
  overlay.width = width;
  overlay.height = height;

  emptyState.style.display = "none";
  fitToScreen();
  renderLayers();
  render();
  saveHistory();
}

function getSelectedLayer() {
  return state.layers.find(l => l.id === state.selectedLayerId) || null;
}

function centerDocument() {
  if (!state.document) return;
  state.panX = (workspace.clientWidth - state.document.width * state.zoom) / 2;
  state.panY = (workspace.clientHeight - state.document.height * state.zoom) / 2;
  applyViewportTransform();
}

function applyViewportTransform() {
  const transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  canvas.style.transform = transform;
  overlay.style.transform = transform;
  zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function render() {
  if (!state.document) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const layer of state.layers) {
    if (!layer.visible) continue;

    ctx.save();
    ctx.globalAlpha = layer.opacity;

    if (layer.mask && !layer.maskDisabled) {
      const temp = document.createElement("canvas");
      temp.width = layer.canvas.width;
      temp.height = layer.canvas.height;
      const tctx = temp.getContext("2d");
      tctx.drawImage(layer.canvas, 0, 0);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(layer.mask, 0, 0);
      ctx.drawImage(temp, layer.x, layer.y);
    } else {
      ctx.drawImage(layer.canvas, layer.x, layer.y);
    }

    ctx.restore();
  }

  drawSelectionOverlay();
}

function drawSelectionOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  const bounds = selectionBounds();
  if (!bounds) return;

  overlayCtx.save();
  overlayCtx.lineWidth = 1;
  overlayCtx.setLineDash([5, 5]);
  overlayCtx.strokeStyle = "#fff";
  overlayCtx.lineDashOffset = -state.marchingOffset;
  overlayCtx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  overlayCtx.strokeStyle = "#000";
  overlayCtx.lineDashOffset = -state.marchingOffset + 5;
  overlayCtx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  overlayCtx.restore();
}

function animateMarchingAnts() {
  state.marchingOffset = (state.marchingOffset + 0.5) % 12;
  drawSelectionOverlay();
  requestAnimationFrame(animateMarchingAnts);
}
animateMarchingAnts();

function screenToDocument(e) {
  const rect = viewport.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - state.panX) / state.zoom,
    y: (e.clientY - rect.top - state.panY) / state.zoom
  };
}

function pointInsideDocument(p) {
  return state.document &&
    p.x >= 0 && p.y >= 0 &&
    p.x <= state.document.width && p.y <= state.document.height;
}

function normalizedRect(r) {
  const x = Math.min(r.x, r.x + r.width);
  const y = Math.min(r.y, r.y + r.height);
  return {
    x, y,
    width: Math.abs(r.width),
    height: Math.abs(r.height)
  };
}

function selectionContains(x, y) {
  if (!state.selection) return true;
  const s = normalizedRect(state.selection);
  return x >= s.x && y >= s.y && x <= s.x + s.width && y <= s.y + s.height;
}

function applySelectionClip(c) {
  if (!state.selection) return false;
  const s = normalizedRect(state.selection);
  c.beginPath();
  c.rect(s.x, s.y, s.width, s.height);
  c.clip();
  return true;
}

function startStroke(e, erase = false) {
  const layer = getSelectedLayer();
  if (!layer || layer.locked) return;

  const p = screenToDocument(e);
  if (!pointInsideDocument(p)) return;

  state.isDrawing = true;
  state.lastPoint = p;

  const target = state.maskEditing && layer.mask ? layer.mask : layer.canvas;
  const c = target.getContext("2d");

  c.save();
  c.globalAlpha = state.brushOpacity;
  c.globalCompositeOperation =
    state.maskEditing && layer.mask
      ? (erase ? "source-over" : "source-over")
      : (erase ? "destination-out" : "source-over");

  if (state.maskEditing && layer.mask) {
    c.strokeStyle = erase ? "#ffffff" : state.brushColor;
  } else {
    c.strokeStyle = state.brushColor;
  }

  c.lineWidth = state.brushSize;
  c.lineCap = "round";
  c.lineJoin = "round";

  if (state.selection) applySelectionClip(c);

  c.beginPath();
  c.moveTo(p.x - layer.x, p.y - layer.y);
  c.lineTo(p.x - layer.x + 0.01, p.y - layer.y + 0.01);
  c.stroke();
  c.restore();

  render();
}

function continueStroke(e, erase = false) {
  if (!state.isDrawing || !state.lastPoint) return;

  const layer = getSelectedLayer();
  if (!layer || layer.locked) return;

  const p = screenToDocument(e);
  const previous = state.lastPoint;

  const target = state.maskEditing && layer.mask ? layer.mask : layer.canvas;
  const c = target.getContext("2d");

  c.save();
  c.globalAlpha = state.brushOpacity;
  c.globalCompositeOperation =
    state.maskEditing && layer.mask ? "source-over" : (erase ? "destination-out" : "source-over");

  if (state.maskEditing && layer.mask) {
    c.strokeStyle = erase ? "#000000" : state.brushColor;
  } else {
    c.strokeStyle = state.brushColor;
  }

  c.lineWidth = state.brushSize;
  c.lineCap = "round";
  c.lineJoin = "round";

  if (state.selection) applySelectionClip(c);

  c.beginPath();
  c.moveTo(previous.x - layer.x, previous.y - layer.y);
  c.lineTo(p.x - layer.x, p.y - layer.y);
  c.stroke();
  c.restore();

  state.lastPoint = p;
  render();
}

function finishStroke() {
  if (!state.isDrawing) return;
  state.isDrawing = false;
  state.lastPoint = null;
  saveHistory();
}


function documentPointForLayer(e) {
  return screenToDocument(e);
}

function pointHitsLayer(layer, p) {
  if (!layer.visible) return false;
  const x = p.x - layer.x;
  const y = p.y - layer.y;
  return x >= 0 && y >= 0 && x < layer.canvas.width && y < layer.canvas.height;
}

function findTopLayerAtPoint(p) {
  for (let i = state.layers.length - 1; i >= 0; i--) {
    if (pointHitsLayer(state.layers[i], p)) return state.layers[i];
  }
  return null;
}

function startMoveOrPan(e) {
  const p = documentPointForLayer(e);
  const hit = findTopLayerAtPoint(p);

  if (hit && !hit.locked) {
    state.selectedLayerId = hit.id;
    state.isMovingLayer = true;
    state.moveStart = {
      pointerX: p.x,
      pointerY: p.y,
      layerX: hit.x,
      layerY: hit.y
    };
    renderLayers();
    renderLayerProperties();
  } else {
    startPan(e);
  }
}

function continueMoveOrPan(e) {
  if (state.isMovingLayer) {
    const layer = getSelectedLayer();
    if (!layer || !state.moveStart) return;

    const p = documentPointForLayer(e);
    layer.x = state.moveStart.layerX + (p.x - state.moveStart.pointerX);
    layer.y = state.moveStart.layerY + (p.y - state.moveStart.pointerY);
    render();
    renderLayers();
    return;
  }

  continuePan(e);
}

function finishMoveOrPan() {
  if (state.isMovingLayer) {
    state.isMovingLayer = false;
    state.moveStart = null;
    saveHistory();
    return;
  }
  finishPan();
}

function startPan(e) {
  state.isPanning = true;
  state.panStart = {
    x: e.clientX,
    y: e.clientY,
    panX: state.panX,
    panY: state.panY
  };
}

function continuePan(e) {
  if (!state.isPanning || !state.panStart) return;
  state.panX = state.panStart.panX + (e.clientX - state.panStart.x);
  state.panY = state.panStart.panY + (e.clientY - state.panStart.y);
  applyViewportTransform();
}

function finishPan() {
  state.isPanning = false;
  state.panStart = null;
}

function startSelection(e) {
  state.isSelecting = true;
  state.selectionStart = screenToDocument(e);
  state.selection = { x: state.selectionStart.x, y: state.selectionStart.y, width: 0, height: 0 };
}

function continueSelection(e) {
  if (!state.isSelecting) return;
  const p = screenToDocument(e);
  const x = Math.round(Math.min(state.selectionStart.x, p.x));
  const y = Math.round(Math.min(state.selectionStart.y, p.y));
  const w = Math.round(Math.abs(p.x - state.selectionStart.x));
  const h = Math.round(Math.abs(p.y - state.selectionStart.y));
  state.selection = { x, y, width: w, height: h };
  render();
  overlayCtx.save();
  overlayCtx.strokeStyle = "#fff";
  overlayCtx.lineWidth = 1;
  overlayCtx.setLineDash([5, 5]);
  overlayCtx.lineDashOffset = -state.marchingOffset;
  overlayCtx.strokeRect(x, y, w, h);
  overlayCtx.strokeStyle = "#000";
  overlayCtx.lineDashOffset = -state.marchingOffset + 5;
  overlayCtx.strokeRect(x, y, w, h);
  overlayCtx.restore();
}

function finishSelection() {
  if (!state.isSelecting || !state.selection) return;

  const s = state.selection;
  if (s.width > 0 && s.height > 0) {
    combineSelectionMask(
      makeRectSelection(s.x, s.y, s.width, s.height),
      state.selectionMode
    );
  }

  state.isSelecting = false;
  state.selectionStart = null;
  state.selection = selectionBounds();
  renderToolOptions();
  render();
}

viewport.addEventListener("pointerdown", e => {
  viewport.setPointerCapture?.(e.pointerId);

  if (e.button !== 0) return;

  if (state.tool === "brush") startStroke(e, false);
  else if (state.tool === "eraser") startStroke(e, true);
  else if (state.tool === "marquee") startSelection(e);
  else if (state.tool === "move") startMoveOrPan(e);
  else if (state.tool === "hand") startPan(e);
});

viewport.addEventListener("pointermove", e => {
  if (state.tool === "brush") continueStroke(e, false);
  else if (state.tool === "eraser") continueStroke(e, true);
  else if (state.tool === "marquee") continueSelection(e);
  else if (state.tool === "move") continueMoveOrPan(e);
  else if (state.tool === "hand") continuePan(e);
});

viewport.addEventListener("pointerup", () => {
  if (state.tool === "brush" || state.tool === "eraser") finishStroke();
  else if (state.tool === "marquee") finishSelection();
  else if (state.tool === "move") finishMoveOrPan();
  else if (state.tool === "hand") finishPan();
});

viewport.addEventListener("pointercancel", () => {
  finishStroke();
  finishPan();
  finishSelection();
});

viewport.addEventListener("wheel", e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  setZoom(state.zoom * factor, e.clientX, e.clientY);
}, { passive: false });

function setZoom(newZoom, screenX = null, screenY = null) {
  if (!state.document) return;

  const oldZoom = state.zoom;
  if (screenX === null) {
    screenX = workspace.getBoundingClientRect().left + workspace.clientWidth / 2;
    screenY = workspace.getBoundingClientRect().top + workspace.clientHeight / 2;
  }

  const rect = viewport.getBoundingClientRect();
  const localX = screenX - rect.left;
  const localY = screenY - rect.top;
  const docX = (localX - state.panX) / oldZoom;
  const docY = (localY - state.panY) / oldZoom;

  state.zoom = Math.max(0.05, Math.min(8, newZoom));
  state.panX = localX - docX * state.zoom;
  state.panY = localY - docY * state.zoom;
  applyViewportTransform();
}

function fitToScreen() {
  if (!state.document) return;

  const padding = 80;
  const availableW = workspace.clientWidth - padding;
  const availableH = workspace.clientHeight - padding;

  state.zoom = Math.min(
    availableW / state.document.width,
    availableH / state.document.height
  );

  centerDocument();
}

function setTool(tool) {
  state.tool = tool;
  state.maskEditing = false;

  document.querySelectorAll(".tool").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });

  renderToolOptions();
}

function renderToolOptions() {
  if (state.tool === "brush" || state.tool === "eraser") {
    const layer = getSelectedLayer();

    toolOptions.innerHTML = `
      <div class="option"><label>Size</label>
        <input id="sizeInput" type="range" min="1" max="300" value="${state.brushSize}">
        <span id="sizeValue">${state.brushSize}px</span>
      </div>
      <div class="option"><label>Opacity</label>
        <input id="opacityInput" type="range" min="1" max="100" value="${state.brushOpacity * 100}">
        <span id="opacityValue">${Math.round(state.brushOpacity * 100)}%</span>
      </div>
      <div class="option"><label>Colour</label>
        <input id="colorInput" type="color" value="${state.brushColor}">
      </div>
      ${layer?.mask ? `<button id="toggleMaskBtn">${state.maskEditing ? "Edit Layer" : "Edit Mask"}</button>` : ""}
    `;

    document.getElementById("sizeInput").oninput = e => {
      state.brushSize = Number(e.target.value);
      document.getElementById("sizeValue").textContent = `${state.brushSize}px`;
    };

    document.getElementById("opacityInput").oninput = e => {
      state.brushOpacity = Number(e.target.value) / 100;
      document.getElementById("opacityValue").textContent = `${Math.round(state.brushOpacity * 100)}%`;
    };

    document.getElementById("colorInput").oninput = e => state.brushColor = e.target.value;

    const toggleMaskBtn = document.getElementById("toggleMaskBtn");
    if (toggleMaskBtn) {
      toggleMaskBtn.onclick = () => {
        state.maskEditing = !state.maskEditing;
        renderToolOptions();
      };
    }
  } else if (state.tool === "marquee") {
    toolOptions.innerHTML = `
      <div class="option"><label>Mode</label>
        <select id="selectionMode">
          <option value="new">New</option>
          <option value="add">Add</option>
          <option value="subtract">Subtract</option>
        </select>
      </div>
      <button id="selectAllBtn">Select All</button>
      <button id="deselectBtn">Deselect</button>
      <button id="invertBtn">Invert</button>
    `;

    document.getElementById("selectionMode").onchange = e => {
      state.selectionMode = e.target.value;
    };

    document.getElementById("selectAllBtn").onclick = () => {
      state.selection = { x: 0, y: 0, width: state.document.width, height: state.document.height };
      drawSelectionOverlay();
      saveHistory();
    };

    document.getElementById("deselectBtn").onclick = () => {
      state.selection = null;
      drawSelectionOverlay();
      saveHistory();
    };

    document.getElementById("invertBtn").onclick = () => {
      if (!state.selection) {
        state.selection = { x: 0, y: 0, width: state.document.width, height: state.document.height };
      } else {
        // Rectangular inversion is represented as four rectangles internally in a later selection-mask milestone.
        // Keep the current rectangular selection stable rather than pretending this is a full arbitrary-mask invert.
        state.selection = null;
      }
      drawSelectionOverlay();
      saveHistory();
    };
  } else if (state.tool === "eyedropper") {
    toolOptions.innerHTML = `<div style="font-size:12px;color:#8e949d">Click the image to sample a colour.</div>`;
  } else {
    toolOptions.innerHTML = `<div style="font-size:12px;color:#8e949d">Move: drag to pan. Use the mouse wheel to zoom.</div>`;
  }
}

document.querySelectorAll(".tool").forEach(btn => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

document.getElementById("newBtn").onclick = () => 
function setupKeyboardShortcuts() {
  window.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea")) return;
    const key = e.key.toLowerCase();

    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      redo();
      return;
    }

    if (key === "v") setTool("move");
    else if (key === "h") setTool("hand");
    else if (key === "b") setTool("brush");
    else if (key === "e") setTool("eraser");
    else if (key === "m") setTool("marquee");
    else if (key === "i") setTool("eyedropper");
  });
}

createDocument(1000, 700);
document.getElementById("openBtn").onclick = () => fileInput.click();

fileInput.onchange = () => {
  const file = fileInput.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    createDocument(img.naturalWidth, img.naturalHeight, img, file.name);
    URL.revokeObjectURL(url);
  };

  img.src = url;
  fileInput.value = "";
};

document.getElementById("exportBtn").onclick = () => {
  if (!state.document) return;

  const link = document.createElement("a");
  link.download = "edited-image.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
};

document.getElementById("zoomInBtn").onclick = () => setZoom(state.zoom * 1.2);
document.getElementById("zoomOutBtn").onclick = () => setZoom(state.zoom / 1.2);
document.getElementById("fitBtn").onclick = fitToScreen;

window.addEventListener("resize", () => {
  if (state.document) centerDocument();
});


function renderLayerProperties() {
  const panel = document.getElementById("layerProperties");
  const layer = getSelectedLayer();

  if (!layer) {
    panel.innerHTML = `<div style="font-size:12px;color:#8e949d">No layer selected.</div>`;
    return;
  }

  panel.innerHTML = `
    <div class="property-row">
      <label>Name</label>
      <input id="layerNameInput" value="${escapeHtml(layer.name)}">
    </div>
    <div class="property-row">
      <label>Opacity</label>
      <input id="layerOpacityInput" type="range" min="0" max="100" value="${Math.round(layer.opacity * 100)}">
      <span id="layerOpacityValue">${Math.round(layer.opacity * 100)}%</span>
    </div>
    <div class="property-row">
      <label>Position</label>
      <span>${Math.round(layer.x)}, ${Math.round(layer.y)}</span>
    </div>
    <div class="property-actions">
      <button id="addMaskBtn">${layer.mask ? "Remove Mask" : "Add Mask"}</button>
      ${layer.mask ? `<button id="applyMaskBtn">Apply Mask</button>` : ""}
      ${layer.mask ? `<button id="disableMaskBtn">${layer.maskDisabled ? "Enable Mask" : "Disable Mask"}</button>` : ""}
    </div>
    <div class="mask-status">${layer.mask ? (state.maskEditing ? "Editing mask" : "Editing layer") : "No mask"}</div>
  `;

  document.getElementById("layerNameInput").onchange = e => {
    layer.name = e.target.value.trim() || "Layer";
    renderLayers();
    saveHistory();
  };

  document.getElementById("layerOpacityInput").oninput = e => {
    layer.opacity = Number(e.target.value) / 100;
    document.getElementById("layerOpacityValue").textContent = `${e.target.value}%`;
    render();
  };

  document.getElementById("layerOpacityInput").onchange = saveHistory;

  document.getElementById("addMaskBtn").onclick = () => {
    if (layer.mask) {
      layer.mask = null;
      layer.maskDisabled = false;
      state.maskEditing = false;
    } else {
      layer.mask = createMask(layer.canvas.width, layer.canvas.height);
      layer.maskDisabled = false;
    }
    render();
    renderLayers();
    renderLayerProperties();
    renderToolOptions();
    saveHistory();
  };

  const apply = document.getElementById("applyMaskBtn");
  if (apply) {
    apply.onclick = () => {
      if (!layer.mask) return;
      const merged = document.createElement("canvas");
      merged.width = layer.canvas.width;
      merged.height = layer.canvas.height;
      const mctx = merged.getContext("2d");
      mctx.drawImage(layer.canvas, 0, 0);
      mctx.globalCompositeOperation = "destination-in";
      mctx.drawImage(layer.mask, 0, 0);
      layer.canvas = merged;
      layer.mask = null;
      layer.maskDisabled = false;
      state.maskEditing = false;
      render();
      renderLayers();
      renderLayerProperties();
      renderToolOptions();
      saveHistory();
    };
  }

  const disable = document.getElementById("disableMaskBtn");
  if (disable) {
    disable.onclick = () => {
      layer.maskDisabled = !layer.maskDisabled;
      render();
      renderLayerProperties();
      renderLayers();
      saveHistory();
    };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const deleteSelectionButton = document.getElementById("deleteSelection");
  if (deleteSelectionButton) {
    deleteSelectionButton.onclick = () => {
      const layer = getSelectedLayer();
      if (!layer || layer.locked || !state.selectionMask) return;

      const mask = document.createElement("canvas");
      mask.width = layer.canvas.width;
      mask.height = layer.canvas.height;
      const mctx = mask.getContext("2d");
      mctx.drawImage(state.selectionMask, -layer.x, -layer.y);

      const ctx = layer.canvas.getContext("2d");
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(mask, 0, 0);
      ctx.restore();

      render();
      renderLayers();
      saveHistory();
    };
  }

}

function renderLayers() {
  layersEl.innerHTML = "";

  [...state.layers].reverse().forEach(layer => {
    const item = document.createElement("div");
    item.className = `layer ${layer.id === state.selectedLayerId ? "selected" : ""}`;
    item.draggable = true;

    item.addEventListener("dragstart", () => {
      state.layerDragId = layer.id;
    });

    item.addEventListener("dragover", e => {
      e.preventDefault();
    });

    item.addEventListener("drop", e => {
      e.preventDefault();
      const fromId = state.layerDragId;
      if (!fromId || fromId === layer.id) return;

      const fromIndex = state.layers.findIndex(l => l.id === fromId);
      const toIndex = state.layers.findIndex(l => l.id === layer.id);
      if (fromIndex < 0 || toIndex < 0) return;

      const [moved] = state.layers.splice(fromIndex, 1);
      state.layers.splice(toIndex, 0, moved);
      state.layerDragId = null;

      renderLayers();
      render();
      saveHistory();
    });

    const thumb = document.createElement("canvas");
    thumb.className = "layer-thumb";
    thumb.width = 68;
    thumb.height = 56;

    const tctx = thumb.getContext("2d");
    const scale = Math.min(68 / layer.canvas.width, 56 / layer.canvas.height);
    const w = layer.canvas.width * scale;
    const h = layer.canvas.height * scale;

    if (layer.mask) {
      tctx.drawImage(layer.canvas, (68 - w) / 2, (56 - h) / 2, w, h);
    } else {
      tctx.drawImage(layer.canvas, (68 - w) / 2, (56 - h) / 2, w, h);
    }

    const visibility = document.createElement("button");
    visibility.className = "layer-visibility";
    visibility.textContent = layer.visible ? "◉" : "○";
    visibility.title = "Toggle visibility";
    visibility.onclick = e => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      render();
      renderLayers();
      saveHistory();
    };

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = `${layer.name}${layer.mask ? "  ◐" : ""}`;

    item.append(visibility, thumb, name);

    item.onclick = () => {
      state.selectedLayerId = layer.id;
      state.maskEditing = false;
      renderLayers();
      renderToolOptions();
      renderLayerProperties();
    };

    layersEl.appendChild(item);
  });
}

document.getElementById("addLayerBtn").onclick = () => {
  if (!state.document) return;

  const layer = createLayer(`Layer ${state.layers.length}`, state.document.width, state.document.height);
  state.layers.push(layer);
  state.selectedLayerId = layer.id;

  renderLayers();
  renderToolOptions();
  render();
  saveHistory();
};

document.getElementById("duplicateLayerBtn").onclick = () => {
  const source = getSelectedLayer();
  if (!source) return;

  const copy = createLayer(`${source.name} copy`, source.canvas.width, source.canvas.height);
  copy.x = source.x + 10;
  copy.y = source.y + 10;
  copy.opacity = source.opacity;
  copy.visible = source.visible;
  copy.locked = false;

  copy.canvas.getContext("2d").drawImage(source.canvas, 0, 0);

  if (source.mask) {
    copy.mask = createMask(source.mask.width, source.mask.height);
    copy.mask.getContext("2d").drawImage(source.mask, 0, 0);
    copy.maskDisabled = source.maskDisabled;
  }

  const index = state.layers.findIndex(l => l.id === source.id);
  state.layers.splice(index + 1, 0, copy);
  state.selectedLayerId = copy.id;

  renderLayers();
  renderLayerProperties();
  render();
  saveHistory();
};

document.getElementById("deleteLayerBtn").onclick = () => {
  if (!state.selectedLayerId || state.layers.length <= 1) return;

  const index = state.layers.findIndex(l => l.id === state.selectedLayerId);
  state.layers.splice(index, 1);
  state.selectedLayerId = state.layers[Math.max(0, index - 1)].id;

  renderLayers();
  renderToolOptions();
  renderLayerProperties();
  render();
  saveHistory();
};

async function dataURLFromCanvas(c) {
  return c.toDataURL("image/png");
}

async function serializeState() {
  return {
    document: state.document ? { ...state.document } : null,
    layers: await Promise.all(state.layers.map(async layer => ({
      id: layer.id,
      name: layer.name,
      x: layer.x,
      y: layer.y,
      opacity: layer.opacity,
      visible: layer.visible,
      locked: layer.locked,
      maskDisabled: !!layer.maskDisabled,
      data: await dataURLFromCanvas(layer.canvas),
      mask: layer.mask ? await dataURLFromCanvas(layer.mask) : null
    }))),
    selectedLayerId: state.selectedLayerId,
    selection: state.selection ? { ...state.selection } : null
  };
}

async function restoreState(snapshot) {
  if (!snapshot.document) return;

  state.document = { ...snapshot.document };
  state.layers = [];

  for (const data of snapshot.layers) {
    const layer = createLayer(data.name, state.document.width, state.document.height);
    layer.id = data.id;
    layer.x = data.x;
    layer.y = data.y;
    layer.opacity = data.opacity;
    layer.visible = data.visible;
    layer.locked = data.locked;
    layer.maskDisabled = !!data.maskDisabled;

    await loadIntoCanvas(data.data, layer.canvas);

    if (data.mask) {
      layer.mask = createMask(state.document.width, state.document.height);
      await loadIntoCanvas(data.mask, layer.mask);
    }

    state.layers.push(layer);
  }

  state.selectedLayerId = snapshot.selectedLayerId;
  state.selection = snapshot.selection ? { ...snapshot.selection } : null;
  state.maskEditing = false;

  canvas.width = state.document.width;
  canvas.height = state.document.height;
  overlay.width = state.document.width;
  overlay.height = state.document.height;

  emptyState.style.display = "none";
  centerDocument();
  render();
  renderLayers();
  renderToolOptions();
}

function loadIntoCanvas(src, target) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      target.getContext("2d").clearRect(0, 0, target.width, target.height);
      target.getContext("2d").drawImage(img, 0, 0);
      resolve();
    };
    img.src = src;
  });
}

async function saveHistory() {
  const snapshot = await serializeState();
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot);
  state.historyIndex = state.history.length - 1;

  if (state.history.length > 20) {
    state.history.shift();
    state.historyIndex--;
  }
}

document.getElementById("undoBtn").onclick = async () => {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  await restoreState(state.history[state.historyIndex]);
};

document.getElementById("redoBtn").onclick = async () => {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  await restoreState(state.history[state.historyIndex]);
};


function setupKeyboardShortcuts() {
  window.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea")) return;
    const key = e.key.toLowerCase();

    if ((e.ctrlKey || e.metaKey) && key === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "y") {
      e.preventDefault();
      redo();
      return;
    }

    if (key === "v") setTool("move");
    else if (key === "h") setTool("hand");
    else if (key === "b") setTool("brush");
    else if (key === "e") setTool("eraser");
    else if (key === "m") setTool("marquee");
    else if (key === "i") setTool("eyedropper");
  });
}

createDocument(1000, 700);
setTool("move");
setupKeyboardShortcuts();
renderLayerProperties();
