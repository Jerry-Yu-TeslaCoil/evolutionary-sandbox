let palette = new Map();

function spectrumColor(index, count) {
  const hue = count <= 1 ? 212 : (index * 360) / count;
  return `hsl(${hue} 70% 42%)`;
}

function assignPalette(frame) {
  const orders = [...new Set((frame?.groups ?? []).filter((group) => group.count > 0).map((group) => group.order))]
    .sort((a, b) => a - b);
  if (orders.length === 0) return;
  palette = new Map(orders.map((order, index) => [order, spectrumColor(index, orders.length)]));
}

function colorOf(order) {
  return palette.get(order) ?? spectrumColor(0, 1);
}

const scalarFields = [
  ["ticks", "最多拍数"],
  ["every", "繁衍间隔"],
  ["eliminate", "淘汰人数"],
  ["seed", "种子"],
  ["ratio", "判断比例"],
  ["flip", "误会率"],
  ["dead", "分数死区"],
  ["approach", "靠近系数"],
  ["coexist", "共存系数"],
  ["follow", "跟随系数"],
  ["flee", "远离系数"],
  ["near", "最近比例"],
  ["stray", "意外相遇"],
  ["window", "回看次数"],
  ["strikes", "背叛次数"],
  ["delay", "每拍毫秒"],
];

const status = document.querySelector("#status");
const errorBox = document.querySelector("#error");
const startButton = document.querySelector("#start");
const pauseButton = document.querySelector("#pause");
const stopButton = document.querySelector("#stop");
const scalarBox = document.querySelector("#scalars");
const countBox = document.querySelector("#counts");
const fieldsets = document.querySelectorAll("fieldset");
const mapCanvas = document.querySelector("#map");
const pieCanvas = document.querySelector("#pie");
const mapNote = document.querySelector("#map-note");
const mapCoreButton = document.querySelector("#map-core");
const mapAllButton = document.querySelector("#map-all");

let categories = [];
let latest = null;
let seenTick = null;
let mapMode = "core";
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let mapView = null;
let hoverOrder = null;
let pieLayout = null;

function field(name, label, value) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  input.value = value ?? "";
  input.autocomplete = "off";
  wrap.append(input);
  return wrap;
}

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || "";
}

function readForm() {
  const data = new FormData(document.querySelector("#params"));
  const counts = {};
  for (const category of categories) counts[category.id] = data.get(`count-${category.id}`);
  const body = { counts };
  for (const [name] of scalarFields) body[name] = data.get(name);
  return body;
}

function resize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const pen = canvas.getContext("2d");
  pen.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { pen, width: rect.width, height: rect.height };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function populationExtent(entities) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const entity of entities) {
    minX = Math.min(minX, entity.x);
    maxX = Math.max(maxX, entity.x);
    minY = Math.min(minY, entity.y);
    maxY = Math.max(maxY, entity.y);
  }
  return { minX, maxX, minY, maxY };
}

function coreMembers(entities) {
  if (entities.length < 4) return entities;
  const cx = median(entities.map((entity) => entity.x));
  const cy = median(entities.map((entity) => entity.y));
  const ranked = entities
    .map((entity) => ({ entity, distance: Math.hypot(entity.x - cx, entity.y - cy) }))
    .sort((a, b) => a.distance - b.distance);
  const start = Math.max(1, Math.ceil(ranked.length * 0.5));
  for (let index = start; index < ranked.length; index += 1) {
    const inner = Math.max(ranked[index - 1].distance, 1e-6);
    if (ranked[index].distance / inner >= 3) return ranked.slice(0, index).map((item) => item.entity);
  }
  return entities;
}

function fittedBounds(bounds, width, height) {
  let { minX, maxX, minY, maxY } = bounds;
  const spanX = Math.max(maxX - minX, 1e-4);
  const spanY = Math.max(maxY - minY, 1e-4);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  minX = centerX - spanX * 0.62;
  maxX = centerX + spanX * 0.62;
  minY = centerY - spanY * 0.62;
  maxY = centerY + spanY * 0.62;
  const worldW = maxX - minX;
  const worldH = maxY - minY;
  const viewAspect = width / Math.max(height, 1);
  const worldAspect = worldW / worldH;
  if (worldAspect > viewAspect) {
    const extra = (worldW / viewAspect - worldH) / 2;
    minY -= extra;
    maxY += extra;
  } else {
    const extra = (worldH * viewAspect - worldW) / 2;
    minX -= extra;
    maxX += extra;
  }
  return { minX, maxX, minY, maxY };
}

function zoomedBounds(home) {
  const centerX = (home.minX + home.maxX) / 2 + mapPanX;
  const centerY = (home.minY + home.maxY) / 2 + mapPanY;
  const halfW = (home.maxX - home.minX) / 2 / mapZoom;
  const halfH = (home.maxY - home.minY) / 2 / mapZoom;
  return { minX: centerX - halfW, maxX: centerX + halfW, minY: centerY - halfH, maxY: centerY + halfH };
}

function edgePoint(px, py, width, height) {
  const margin = 12;
  const centerX = width / 2;
  const centerY = height / 2;
  const dx = px - centerX;
  const dy = py - centerY;
  const halfW = width / 2 - margin;
  const halfH = height / 2 - margin;
  const scale = Math.min(halfW / Math.max(Math.abs(dx), 1e-6), halfH / Math.max(Math.abs(dy), 1e-6));
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

function drawMap(frame) {
  const { pen, width, height } = resize(mapCanvas);
  pen.clearRect(0, 0, width, height);
  pen.fillStyle = "#fbfaf6";
  pen.fillRect(0, 0, width, height);
  const entities = frame?.entities ?? [];
  if (entities.length === 0) {
    mapView = null;
    mapNote.textContent = "";
    pen.fillStyle = "#a8a29e";
    pen.font = "14px sans-serif";
    pen.fillText("还没有人", 16, 28);
    return;
  }
  const members = mapMode === "core" ? coreMembers(entities) : entities;
  const home = fittedBounds(populationExtent(members), width, height);
  const view = zoomedBounds(home);
  mapView = view;
  const projectX = (x) => ((x - view.minX) / (view.maxX - view.minX)) * width;
  const projectY = (y) => height - ((y - view.minY) / (view.maxY - view.minY)) * height;
  pen.strokeStyle = "#e7e2d8";
  pen.lineWidth = 1;
  if (view.minX < 0 && view.maxX > 0) {
    const x = projectX(0);
    pen.beginPath();
    pen.moveTo(x, 0);
    pen.lineTo(x, height);
    pen.stroke();
  }
  if (view.minY < 0 && view.maxY > 0) {
    const y = projectY(0);
    pen.beginPath();
    pen.moveTo(0, y);
    pen.lineTo(width, y);
    pen.stroke();
  }
  const radius = Math.max(3, Math.min(7, 160 / Math.sqrt(entities.length)));
  const inside = [];
  const outside = [];
  for (const entity of entities) {
    const x = projectX(entity.x);
    const y = projectY(entity.y);
    if (x >= radius && x <= width - radius && y >= radius && y <= height - radius) inside.push({ entity, x, y });
    else outside.push({ entity, x, y });
  }
  const paintDot = (x, y, order, dotRadius, ring) => {
    const faded = hoverOrder !== null && order !== hoverOrder;
    pen.save();
    pen.globalAlpha = faded ? 0.32 : 1;
    pen.beginPath();
    pen.fillStyle = colorOf(order);
    pen.arc(x, y, dotRadius, 0, Math.PI * 2);
    pen.fill();
    if (ring) {
      pen.lineWidth = 1;
      pen.strokeStyle = faded ? "rgba(28, 25, 23, 0.28)" : "#1c1917";
      pen.stroke();
    }
    pen.restore();
  };
  const strokeRing = (x, y, dotRadius, color, width) => {
    pen.beginPath();
    pen.lineWidth = width;
    pen.strokeStyle = color;
    pen.arc(x, y, dotRadius + 3.4, 0, Math.PI * 2);
    pen.stroke();
  };
  const paintFocus = (points) => {
    if (hoverOrder === null || points.length === 0) return;
    pen.save();
    pen.globalAlpha = 1;
    for (const point of points) strokeRing(point.x, point.y, point.radius, "#fffdf8", 5);
    for (const point of points) strokeRing(point.x, point.y, point.radius, "#1c1917", 2.2);
    for (const point of points) {
      pen.beginPath();
      pen.fillStyle = colorOf(point.order);
      pen.arc(point.x, point.y, point.radius + 0.8, 0, Math.PI * 2);
      pen.fill();
    }
    pen.restore();
  };
  const byFocus = (a, b) => Number(a.order === hoverOrder) - Number(b.order === hoverOrder);
  const insideDots = inside.map((point) => ({ x: point.x, y: point.y, order: point.entity.order, radius }));
  insideDots.sort(byFocus);
  for (const point of insideDots) {
    if (point.order === hoverOrder) continue;
    paintDot(point.x, point.y, point.order, point.radius, false);
  }
  const outsideDots = outside.map((point, index) => {
    const spot = edgePoint(point.x, point.y, width, height);
    const shift = (index - (outside.length - 1) / 2) * 11;
    const horizontal = Math.abs(spot.x - width / 2) >= Math.abs(spot.y - height / 2);
    return {
      x: horizontal ? spot.x : Math.min(width - 12, Math.max(12, spot.x + shift)),
      y: horizontal ? Math.min(height - 12, Math.max(12, spot.y + shift)) : spot.y,
      order: point.entity.order,
      radius: Math.max(3, radius * 0.8),
    };
  });
  outsideDots.sort(byFocus);
  for (const point of outsideDots) {
    if (point.order === hoverOrder) continue;
    paintDot(point.x, point.y, point.order, point.radius, true);
  }
  paintFocus(insideDots.filter((point) => point.order === hoverOrder));
  paintFocus(outsideDots.filter((point) => point.order === hoverOrder));
  mapNote.textContent = outside.length ? `视野外 ${outside.length}` : "";
}

function containsAngle(angle, start, sweep) {
  const turn = Math.PI * 2;
  const delta = ((angle - start) % turn + turn) % turn;
  return delta <= sweep + 1e-3;
}

function sliceHit(px, py, slice, layout, popped) {
  const reach = popped ? 10 : 0;
  const cx = layout.centerX + Math.cos(slice.mid) * reach;
  const cy = layout.centerY + Math.sin(slice.mid) * reach;
  const dx = px - cx;
  const dy = py - cy;
  const distance = Math.hypot(dx, dy);
  const inner = popped ? layout.inner * 0.72 : layout.inner;
  if (distance < inner || distance > layout.radius + (popped ? 6 : 1)) return false;
  const pad = 5 / layout.radius;
  return containsAngle(Math.atan2(dy, dx), slice.start - pad, slice.sweep + pad * 2);
}

function pieOrderAt(px, py) {
  const layout = pieLayout;
  if (!layout) return null;
  for (const row of layout.legends) {
    if (px >= 8 && px <= layout.width - 8 && py >= row.y - 2 && py <= row.y + row.h + 2) return row.order;
  }
  for (const slice of layout.slices) {
    if (slice.order === hoverOrder && (sliceHit(px, py, slice, layout, true) || sliceHit(px, py, slice, layout, false))) {
      return slice.order;
    }
  }
  for (const slice of layout.slices) {
    if (sliceHit(px, py, slice, layout, false)) return slice.order;
  }
  return null;
}

function drawPie(frame) {
  const { pen, width, height } = resize(pieCanvas);
  pen.clearRect(0, 0, width, height);
  pen.fillStyle = "#fbfaf6";
  pen.fillRect(0, 0, width, height);
  const groups = (frame?.groups ?? []).filter((group) => group.count > 0);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  if (total === 0) {
    pieLayout = null;
    pen.fillStyle = "#a8a29e";
    pen.font = "14px sans-serif";
    pen.fillText("还没有种群", 16, 28);
    return;
  }
  const rows = groups.length;
  const legendRoom = Math.min(height * 0.42, rows * 20);
  const legendRow = legendRoom / rows;
  const radius = Math.max(24, Math.min(width / 2 - 20, (height - legendRoom) / 2 - 12));
  const block = radius * 2 + 16 + legendRoom;
  const top = Math.max(8, (height - block) / 2);
  const centerX = width / 2;
  const centerY = top + radius;
  let angle = -Math.PI / 2;
  const slices = groups.map((group) => {
    const sweep = (group.count / total) * Math.PI * 2;
    const slice = { order: group.order, start: angle, sweep, mid: angle + sweep / 2 };
    angle += sweep;
    return slice;
  });
  const legends = groups.map((group, index) => ({
    order: group.order,
    y: centerY + radius + 16 + index * legendRow,
    h: legendRow,
  }));
  pieLayout = { width, height, centerX, centerY, radius, inner: radius * 0.52, slices, legends };
  const drawSlice = (slice) => {
    const popped = slice.order === hoverOrder;
    const reach = popped ? 10 : 0;
    pen.beginPath();
    pen.moveTo(centerX + Math.cos(slice.mid) * reach, centerY + Math.sin(slice.mid) * reach);
    pen.fillStyle = colorOf(slice.order);
    pen.globalAlpha = hoverOrder !== null && !popped ? 0.45 : 1;
    pen.arc(
      centerX + Math.cos(slice.mid) * reach,
      centerY + Math.sin(slice.mid) * reach,
      popped ? radius + 4 : radius,
      slice.start,
      slice.start + slice.sweep,
    );
    pen.closePath();
    pen.fill();
    pen.globalAlpha = 1;
  };
  for (const slice of slices) if (slice.order !== hoverOrder) drawSlice(slice);
  for (const slice of slices) if (slice.order === hoverOrder) drawSlice(slice);
  pen.fillStyle = "#fbfaf6";
  pen.beginPath();
  pen.arc(centerX, centerY, radius * 0.52, 0, Math.PI * 2);
  pen.fill();
  pen.fillStyle = "#1c1917";
  pen.font = "13px sans-serif";
  pen.textAlign = "center";
  pen.fillText(`${total} 人`, centerX, centerY + 4);
  pen.textAlign = "left";
  groups.forEach((group, index) => {
    const row = legends[index];
    const popped = group.order === hoverOrder;
    const faded = hoverOrder !== null && !popped;
    pen.save();
    pen.globalAlpha = faded ? 0.42 : 1;
    if (popped) {
      pen.fillStyle = colorOf(group.order);
      pen.globalAlpha = 0.16;
      pen.beginPath();
      pen.roundRect(8, row.y - 3, width - 16, Math.max(16, row.h), 5);
      pen.fill();
      pen.globalAlpha = 1;
    }
    pen.fillStyle = colorOf(group.order);
    pen.fillRect(popped ? 14 : 16, row.y + (popped ? -1 : 0), popped ? 12 : 10, popped ? 12 : 10);
    pen.fillStyle = "#1c1917";
    pen.font = popped ? "bold 12.5px sans-serif" : "12px sans-serif";
    const percent = Math.round((group.count / total) * 1000) / 10;
    pen.fillText(`${group.label}  ${group.count}  ${percent}%`, 34, row.y + 10);
    pen.restore();
  });
}

function paint() {
  const groups = latest?.groups ?? [];
  if (hoverOrder !== null && !groups.some((group) => group.count > 0 && group.order === hoverOrder)) hoverOrder = null;
  drawMap(latest);
  drawPie(latest);
}

function setHover(order) {
  if (order === hoverOrder) return;
  hoverOrder = order;
  pieCanvas.style.cursor = order === null ? "default" : "pointer";
  paint();
}

function applyPhase(frame) {
  const phase = frame?.phase ?? "idle";
  const running = phase === "running" || phase === "paused";
  startButton.disabled = running;
  pauseButton.disabled = !running;
  stopButton.disabled = !running;
  pauseButton.textContent = phase === "paused" ? "继续" : "暂停";
  for (const fieldset of fieldsets) fieldset.disabled = running;
  const head = frame && frame.population
    ? `第 ${frame.tick} 拍 · ${frame.population} 人`
    : "尚未开局";
  status.textContent = frame?.message ? `${head} · ${frame.message}` : head;
}

function resetMapView() {
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
}

function setMapMode(mode) {
  mapMode = mode;
  mapCoreButton.classList.toggle("active", mode === "core");
  mapAllButton.classList.toggle("active", mode === "all");
  resetMapView();
  paint();
}

function pixelToWorld(px, py) {
  const rect = mapCanvas.getBoundingClientRect();
  const view = mapView;
  if (!view) return null;
  return {
    x: view.minX + (px / rect.width) * (view.maxX - view.minX),
    y: view.minY + (1 - py / rect.height) * (view.maxY - view.minY),
  };
}

function onFrame(frame) {
  const fresh = seenTick === null || frame.tick < seenTick;
  if (fresh) {
    resetMapView();
    palette = new Map();
  }
  if (palette.size === 0) assignPalette(frame);
  seenTick = frame.tick;
  latest = frame;
  applyPhase(frame);
  paint();
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
}

async function loadMeta() {
  const response = await fetch("/api/meta");
  const meta = await response.json();
  categories = meta.categories;
  for (const [name, label] of scalarFields) scalarBox.append(field(name, label, meta.values[name]));
  for (const category of categories) {
    countBox.append(field(`count-${category.id}`, `${category.index} ${category.label}`, String(category.count)));
  }
}

startButton.addEventListener("click", async () => {
  showError("");
  try {
    await post("/api/start", readForm());
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
});

pauseButton.addEventListener("click", async () => {
  showError("");
  try {
    await post("/api/pause");
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
});

stopButton.addEventListener("click", async () => {
  showError("");
  try {
    await post("/api/stop");
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
});

mapCoreButton.addEventListener("click", () => setMapMode("core"));
mapAllButton.addEventListener("click", () => setMapMode("all"));

mapCanvas.addEventListener("wheel", (event) => {
  if (!mapView) return;
  event.preventDefault();
  const rect = mapCanvas.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const before = pixelToWorld(px, py);
  mapZoom = Math.min(80, Math.max(0.4, mapZoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
  paint();
  const after = pixelToWorld(px, py);
  if (before && after) {
    mapPanX += before.x - after.x;
    mapPanY += before.y - after.y;
    paint();
  }
}, { passive: false });

let mapDrag = null;
mapCanvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !mapView) return;
  mapDrag = {
    x: event.clientX,
    y: event.clientY,
    panX: mapPanX,
    panY: mapPanY,
    worldW: mapView.maxX - mapView.minX,
    worldH: mapView.maxY - mapView.minY,
  };
  mapCanvas.setPointerCapture(event.pointerId);
  mapCanvas.classList.add("dragging");
});
mapCanvas.addEventListener("pointermove", (event) => {
  if (!mapDrag) return;
  const rect = mapCanvas.getBoundingClientRect();
  const dx = event.clientX - mapDrag.x;
  const dy = event.clientY - mapDrag.y;
  mapPanX = mapDrag.panX - (dx / rect.width) * mapDrag.worldW;
  mapPanY = mapDrag.panY + (dy / rect.height) * mapDrag.worldH;
  paint();
});
function endMapDrag() {
  mapDrag = null;
  mapCanvas.classList.remove("dragging");
}
mapCanvas.addEventListener("pointerup", endMapDrag);
mapCanvas.addEventListener("pointercancel", endMapDrag);
mapCanvas.addEventListener("dblclick", () => {
  resetMapView();
  paint();
});

pieCanvas.addEventListener("pointermove", (event) => {
  const rect = pieCanvas.getBoundingClientRect();
  setHover(pieOrderAt(event.clientX - rect.left, event.clientY - rect.top));
});
pieCanvas.addEventListener("pointerleave", () => setHover(null));

window.addEventListener("resize", paint);

loadMeta().catch((error) => {
  showError(error instanceof Error ? error.message : String(error));
});

const stream = new EventSource("/api/events");
stream.onmessage = (event) => onFrame(JSON.parse(event.data));
stream.onerror = () => {
  status.textContent = "和可视化服务断开了。";
};
