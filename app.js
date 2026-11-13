import {
  FaceLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs";

// ---------- DOM ----------
const els = {
  video: document.getElementById("webcam"),
  photo: document.getElementById("photo"),
  canvas: document.getElementById("overlay"),
  stageMsg: document.getElementById("stage-message"),
  modeTabs: [...document.querySelectorAll(".mode-tab")],
  startCam: document.getElementById("startCam"),
  stopCam: document.getElementById("stopCam"),
  mirror: document.getElementById("mirror"),
  showMesh: document.getElementById("showMesh"),
  photoInput: document.getElementById("photoInput"),
  camGroup: document.querySelector('.control-group[data-for="camera"]'),
  photoGroup: document.querySelector('.control-group[data-for="photo"]'),
  saveBtn: document.getElementById("saveBtn"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  history: document.getElementById("history"),
  tagBtns: document.getElementById("tagBtns"),
  noteInput: document.getElementById("noteInput"),
  savePhoto: document.getElementById("savePhoto"),
  trend: document.getElementById("trend"),
  trendMetric: document.getElementById("trendMetric"),
  chart: document.getElementById("chart"),
  comparePanel: document.getElementById("comparePanel"),
  historyHint: document.getElementById("historyHint"),
};
let currentTag = "朝";
let picked = []; // 比較用に選んだ記録の日時(id)
const ctx = els.canvas.getContext("2d");

// ---------- state ----------
let faceLandmarker = null;
let drawingUtils = null;
let runningMode = "IMAGE";
let mode = "camera";
let stream = null;
let rafId = null;
let lastVideoTime = -1;
let latest = null; // 最新の計測結果

// ---------- MediaPipe 初期化 ----------
async function initLandmarker() {
  setMsg("AIモデルを読み込み中…（初回は数秒かかります）");
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      outputFaceBlendshapes: true,
      runningMode,
      numFaces: 1,
    });
    drawingUtils = new DrawingUtils(ctx);
    setMsg("準備完了。カメラを開始するか、写真を選んでください。");
  } catch (e) {
    console.error(e);
    setMsg("モデルの読み込みに失敗しました。通信環境を確認して再読み込みしてください。");
  }
}

function setMsg(text) {
  if (!text) {
    els.stageMsg.classList.add("hidden");
  } else {
    els.stageMsg.textContent = text;
    els.stageMsg.classList.remove("hidden");
  }
}

async function ensureRunningMode(wanted) {
  if (!faceLandmarker || runningMode === wanted) return;
  runningMode = wanted;
  await faceLandmarker.setOptions({ runningMode: wanted });
}

// ---------- モード切替 ----------
els.modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => switchMode(tab.dataset.mode));
});

function switchMode(next) {
  mode = next;
  els.modeTabs.forEach((t) => t.classList.toggle("is-active", t.dataset.mode === next));
  els.camGroup.hidden = next !== "camera";
  els.photoGroup.hidden = next !== "photo";
  stopCamera();
  if (next === "camera") {
    els.photo.hidden = true;
    els.video.hidden = false;
    setMsg("「カメラを開始」を押してください。");
  } else {
    els.video.hidden = true;
    els.photo.hidden = false;
    setMsg("「写真を選ぶ」から顔写真をアップしてください。");
  }
  clearCanvas();
}

// ---------- カメラ ----------
els.startCam.addEventListener("click", startCamera);
els.stopCam.addEventListener("click", stopCamera);
els.mirror.addEventListener("change", applyMirror);
applyMirror();

function applyMirror() {
  const on = els.mirror.checked;
  els.video.classList.toggle("mirror", on);
  els.canvas.classList.toggle("mirror", on);
}

async function startCamera() {
  if (!faceLandmarker) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.startCam.hidden = true;
    els.stopCam.hidden = false;
    setMsg("");
    await ensureRunningMode("VIDEO");
    predictVideo();
  } catch (e) {
    console.error(e);
    setMsg("カメラを使えませんでした。ブラウザのカメラ許可を確認してください。");
  }
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId), (rafId = null);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  els.video.srcObject = null;
  els.startCam.hidden = false;
  els.stopCam.hidden = true;
}

async function predictVideo() {
  if (!stream || mode !== "camera") return;
  sizeCanvasTo(els.video.videoWidth, els.video.videoHeight);
  if (els.video.currentTime !== lastVideoTime) {
    lastVideoTime = els.video.currentTime;
    const res = faceLandmarker.detectForVideo(els.video, performance.now());
    handleResult(res);
  }
  rafId = requestAnimationFrame(predictVideo);
}

// ---------- 写真 ----------
els.photoInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file || !faceLandmarker) return;
  const url = URL.createObjectURL(file);
  els.photo.onload = async () => {
    URL.revokeObjectURL(url);
    setMsg("");
    sizeCanvasTo(els.photo.naturalWidth, els.photo.naturalHeight);
    els.canvas.classList.remove("mirror"); // 写真は反転しない
    await ensureRunningMode("IMAGE");
    const res = faceLandmarker.detect(els.photo);
    handleResult(res);
  };
  els.photo.src = url;
});

// ---------- 共通：結果処理 ----------
function sizeCanvasTo(w, h) {
  if (!w || !h) return;
  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
}
function clearCanvas() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
}

function handleResult(res) {
  clearCanvas();
  if (!res || !res.faceLandmarks || res.faceLandmarks.length === 0) {
    setMsg(mode === "camera" ? "顔を枠の中に入れてください。" : "顔を検出できませんでした。正面の写真でお試しください。");
    latest = null;
    return;
  }
  setMsg("");
  const lm = res.faceLandmarks[0];
  const bs = toBlendshapeMap(res.faceBlendshapes?.[0]);
  if (els.showMesh.checked && drawingUtils) drawMesh(lm);

  const w = els.canvas.width, h = els.canvas.height;
  const metrics = computeMetrics(lm, bs, w, h);
  latest = metrics;
  renderMetrics(metrics);
}

function toBlendshapeMap(blend) {
  const map = {};
  if (blend?.categories) for (const c of blend.categories) map[c.categoryName] = c.score;
  return map;
}
const bsv = (map, name) => map[name] ?? 0;

// ---------- 幾何計算 ----------
// landmark -> ピクセル座標
function px(lm, i, w, h) {
  return { x: lm[i].x * w, y: lm[i].y * h };
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
// roll補正：両目外側を水平にそろえた座標系に回転
function makeRotator(lm, w, h) {
  const rOuter = px(lm, 33, w, h);
  const lOuter = px(lm, 263, w, h);
  const cx = (rOuter.x + lOuter.x) / 2;
  const cy = (rOuter.y + lOuter.y) / 2;
  const angle = Math.atan2(lOuter.y - rOuter.y, lOuter.x - rOuter.x);
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  return (i) => {
    const p = px(lm, i, w, h);
    const dx = p.x - cx, dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  };
}

function computeMetrics(lm, bs, w, h) {
  const R = makeRotator(lm, w, h);
  const interocular = dist(R(33), R(263)) || 1; // スケール基準

  // --- 目の開き（上まぶた〜下まぶたの垂直距離） ---
  const eyeA = openness(R, 159, 145, interocular); // 片目（画像座標）
  const eyeB = openness(R, 386, 374, interocular); // もう片目
  // 本人の右側＝画像上xが小さい方
  const aIsRight = R(33).x < R(263).x; // 33側が小さいxなら33=本人の右
  const eyeRight = aIsRight ? eyeA : eyeB;
  const eyeLeft = aIsRight ? eyeB : eyeA;
  const eyeAsym = asymPct(eyeLeft, eyeRight);

  // --- 口角の高さ（口の中心に対する口角の持ち上がり） ---
  const mouthCenterY = (R(13).y + R(14).y) / 2;
  const cornerA = R(61), cornerB = R(291);
  const liftA = (mouthCenterY - cornerA.y) / interocular; // 正＝上がってる
  const liftB = (mouthCenterY - cornerB.y) / interocular;
  const cAIsRight = cornerA.x < cornerB.x;
  const mouthRight = cAIsRight ? liftA : liftB;
  const mouthLeft = cAIsRight ? liftB : liftA;
  const mouthAsym = asymPct(mouthLeft + 0.5, mouthRight + 0.5); // オフセットで負対策

  // --- 左右対称スコア ---
  const sym = symmetryScore(R, interocular);

  // --- 笑顔のタイプ（blendshape） ---
  const smile = (bsv(bs, "mouthSmileLeft") + bsv(bs, "mouthSmileRight")) / 2;
  const cheek = (bsv(bs, "cheekSquintLeft") + bsv(bs, "cheekSquintRight")) / 2;
  const stretch = (bsv(bs, "mouthStretchLeft") + bsv(bs, "mouthStretchRight")) / 2;
  // 斜め上度：笑み＋頬上げ。横引き度：ストレッチ
  const upScore = Math.min(1, smile * 0.6 + cheek * 1.2);
  const sideScore = Math.min(1, stretch * 1.1);
  const smiling = smile > 0.15 || stretch > 0.15;

  return {
    date: new Date().toISOString(),
    eyeLeft, eyeRight, eyeAsym,
    mouthLeft, mouthRight, mouthAsym,
    sym,
    smile, upScore, sideScore, smiling,
  };
}

function openness(R, topI, botI, scale) {
  return dist(R(topI), R(botI)) / scale;
}
function asymPct(a, b) {
  const m = Math.max(Math.abs(a), Math.abs(b)) || 1;
  return Math.min(100, (Math.abs(a - b) / m) * 100);
}

// 左右対称：複数ペアの「中心線からの距離差」＋「高さ差」
const SYM_PAIRS = [
  [33, 263], [133, 362], [61, 291], [234, 454], [105, 334], [58, 288],
];
function symmetryScore(R, scale) {
  const midX = (R(168).x + R(1).x + R(164).x) / 3;
  let err = 0;
  for (const [ri, li] of SYM_PAIRS) {
    const a = R(ri), b = R(li);
    const left = a.x < b.x ? a : b;
    const right = a.x < b.x ? b : a;
    const hDiff = Math.abs((midX - left.x) - (right.x - midX));
    const vDiff = Math.abs(a.y - b.y);
    err += (hDiff + vDiff) / scale;
  }
  err /= SYM_PAIRS.length;
  return Math.max(0, Math.min(100, Math.round(100 - err * 220)));
}

// ---------- 描画（メッシュ） ----------
function drawMesh(lm) {
  const C = FaceLandmarker;
  const opt = { color: "rgba(232,106,146,0.35)", lineWidth: 1 };
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_TESSELATION, { color: "rgba(255,255,255,0.12)", lineWidth: 0.5 });
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_RIGHT_EYE, opt);
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_LEFT_EYE, opt);
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_LIPS, opt);
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_FACE_OVAL, { color: "rgba(255,255,255,0.25)", lineWidth: 1 });
}

// ---------- 表示 ----------
function setBar(id, pct) {
  document.getElementById(id).style.width = Math.max(0, Math.min(100, pct)) + "%";
}
function setVerdict(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "verdict" + (id.includes("sym") ? " big" : "") + (cls ? " " + cls : "");
}

function renderMetrics(m) {
  // 目
  const eyeLpct = Math.min(100, (m.eyeLeft / 0.14) * 100);
  const eyeRpct = Math.min(100, (m.eyeRight / 0.14) * 100);
  setBar("eyeL-bar", eyeLpct); setBar("eyeR-bar", eyeRpct);
  document.getElementById("eyeL-val").textContent = eyeLpct.toFixed(0);
  document.getElementById("eyeR-val").textContent = eyeRpct.toFixed(0);
  document.getElementById("eye-asym").textContent = m.eyeAsym.toFixed(0) + "%";
  setVerdict("eye-verdict", m.eyeAsym < 10 ? "左右そろってる" : m.eyeAsym < 20 ? "やや左右差" : "左右差あり",
    m.eyeAsym < 10 ? "is-good" : m.eyeAsym < 20 ? "" : "is-warn");

  // 口角
  const mLpct = (m.mouthLeft + 0.1) * 400;
  const mRpct = (m.mouthRight + 0.1) * 400;
  setBar("mouthL-bar", mLpct); setBar("mouthR-bar", mRpct);
  document.getElementById("mouthL-val").textContent = (m.mouthLeft * 100).toFixed(0);
  document.getElementById("mouthR-val").textContent = (m.mouthRight * 100).toFixed(0);
  document.getElementById("mouth-asym").textContent = m.mouthAsym.toFixed(0) + "%";
  setVerdict("mouth-verdict", m.mouthAsym < 12 ? "左右そろってる" : m.mouthAsym < 25 ? "やや左右差" : "左右差あり",
    m.mouthAsym < 12 ? "is-good" : m.mouthAsym < 25 ? "" : "is-warn");

  // 対称
  document.getElementById("sym-score").textContent = m.sym;
  document.getElementById("sym-ring").style.background =
    `conic-gradient(var(--brand) ${m.sym * 3.6}deg, #eef0f6 0deg)`;
  setVerdict("sym-verdict", m.sym >= 90 ? "とても良い" : m.sym >= 80 ? "良い" : "左右差あり",
    m.sym >= 90 ? "is-good" : m.sym >= 80 ? "" : "is-warn");

  // 笑顔
  setBar("cheek-bar", m.upScore * 100);
  setBar("stretch-bar", m.sideScore * 100);
  document.getElementById("cheek-val").textContent = (m.upScore * 100).toFixed(0);
  document.getElementById("stretch-val").textContent = (m.sideScore * 100).toFixed(0);
  let sv, sc;
  if (!m.smiling) { sv = "笑ってみて"; sc = ""; }
  else if (m.upScore >= m.sideScore + 0.1) { sv = "◎ 斜め上タイプ"; sc = "is-good"; }
  else if (m.sideScore > m.upScore) { sv = "⚠ 横引きの癖"; sc = "is-warn"; }
  else { sv = "ミックス"; sc = ""; }
  setVerdict("smile-verdict", sv, sc);
}

// ---------- 記録（localStorage） ----------
const STORE_KEY = "hyojokin-records-v1";
function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function saveRecords(arr) {
  localStorage.setItem(STORE_KEY, JSON.stringify(arr));
}
function getManual() {
  const o = {};
  document.querySelectorAll(".manual").forEach((c) => (o[c.dataset.key] = c.checked));
  return o;
}

// タグ選択
els.tagBtns.addEventListener("click", (e) => {
  const btn = e.target.closest(".tag-btn");
  if (!btn) return;
  currentTag = btn.dataset.tag;
  els.tagBtns.querySelectorAll(".tag-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
});

// 現在の映像/写真から小さなサムネイルを取得
function captureThumb() {
  try {
    const src = mode === "camera" ? els.video : els.photo;
    const sw = mode === "camera" ? src.videoWidth : src.naturalWidth;
    const sh = mode === "camera" ? src.videoHeight : src.naturalHeight;
    if (!sw || !sh) return null;
    const tw = 220, th = Math.round((sh / sw) * tw);
    const c = document.createElement("canvas");
    c.width = tw; c.height = th;
    const cx = c.getContext("2d");
    if (mode === "camera" && els.mirror.checked) { cx.translate(tw, 0); cx.scale(-1, 1); }
    cx.drawImage(src, 0, 0, tw, th);
    return c.toDataURL("image/jpeg", 0.7);
  } catch { return null; }
}

els.saveBtn.addEventListener("click", () => {
  if (!latest) { alert("先に顔を映して計測してください。"); return; }
  const rec = {
    ...latest,
    tag: currentTag,
    note: els.noteInput.value.trim(),
    thumb: els.savePhoto.checked ? captureThumb() : null,
    manual: getManual(),
  };
  const arr = loadRecords();
  arr.unshift(rec);
  try {
    saveRecords(arr);
  } catch {
    // 容量オーバー時は写真を外して再保存
    rec.thumb = null;
    saveRecords(arr);
    alert("保存容量がいっぱいのため、今回は写真なしで記録しました。");
  }
  els.noteInput.value = "";
  refreshRecordUI();
});

els.clearBtn.addEventListener("click", () => {
  if (confirm("記録をすべて削除します。よろしいですか？")) {
    saveRecords([]);
    picked = [];
    refreshRecordUI();
  }
});

els.trendMetric.addEventListener("change", renderChart);

els.exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(loadRecords(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `表情筋記録_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function smileBalance(r) { return Math.round((r.upScore - r.sideScore) * 100); }

// 記録UI全体を更新（履歴＋グラフ＋比較）
function refreshRecordUI() {
  renderHistory();
  renderChart();
  renderCompare();
}

function renderHistory() {
  const arr = loadRecords();
  els.historyHint.hidden = arr.length < 2;
  els.history.innerHTML = "";
  arr.forEach((r) => {
    const item = document.createElement("div");
    item.className = "hist-item" + (picked.includes(r.date) ? " is-picked" : "");
    const thumb = r.thumb
      ? `<img class="hist-thumb" src="${r.thumb}" alt="" />`
      : `<span class="hist-thumb placeholder">👤</span>`;
    const tag = r.tag ? `<span class="hist-tag ${r.tag}">${r.tag}</span>` : "";
    const note = r.note ? `<span class="hist-note">${escapeHtml(r.note)}</span>` : "";
    item.innerHTML = `
      <input type="checkbox" class="hist-pick" ${picked.includes(r.date) ? "checked" : ""} />
      ${thumb}
      <span class="hist-main">
        <span><span class="hist-date">${fmtDate(r.date)}</span>${tag}</span>
        ${note}
        <span class="hist-metrics">
          <span>対称 ${r.sym}</span>
          <span>目差 ${r.eyeAsym?.toFixed(0) ?? "-"}%</span>
          <span>口角差 ${r.mouthAsym?.toFixed(0) ?? "-"}%</span>
          <span>笑顔 ↗${(r.upScore * 100).toFixed(0)}/↔${(r.sideScore * 100).toFixed(0)}</span>
        </span>
      </span>
      <button class="hist-del" title="削除">✕</button>`;
    item.querySelector(".hist-pick").addEventListener("change", (e) => togglePick(r.date, e.target.checked));
    item.querySelector(".hist-del").addEventListener("click", () => {
      const arr2 = loadRecords().filter((x) => x.date !== r.date);
      saveRecords(arr2);
      picked = picked.filter((p) => p !== r.date);
      refreshRecordUI();
    });
    els.history.appendChild(item);
  });
}

function togglePick(id, on) {
  if (on) {
    picked.push(id);
    if (picked.length > 2) picked.shift(); // 最新2つだけ保持
  } else {
    picked = picked.filter((p) => p !== id);
  }
  refreshRecordUI();
}

// 比較パネル
function renderCompare() {
  if (picked.length !== 2) { els.comparePanel.hidden = true; return; }
  const arr = loadRecords();
  const recs = picked.map((id) => arr.find((r) => r.date === id)).filter(Boolean);
  if (recs.length !== 2) { els.comparePanel.hidden = true; return; }
  // 古い→新しい の順に
  recs.sort((a, b) => new Date(a.date) - new Date(b.date));
  const [a, b] = recs;
  const img = (r) => r.thumb ? `<img src="${r.thumb}" alt="" />` : `<div class="hist-thumb placeholder" style="width:100%;height:160px">写真なし</div>`;
  const deltas = [
    { label: "対称スコア", a: a.sym, b: b.sym, better: "up" },
    { label: "目の左右差%", a: a.eyeAsym, b: b.eyeAsym, better: "down" },
    { label: "口角の左右差%", a: a.mouthAsym, b: b.mouthAsym, better: "down" },
    { label: "笑顔バランス", a: smileBalance(a), b: smileBalance(b), better: "up" },
  ].map((d) => {
    const diff = (d.b - d.a);
    const good = d.better === "up" ? diff > 0 : diff < 0;
    const sign = diff > 0 ? "+" : "";
    const cls = diff === 0 ? "" : good ? "delta-up" : "delta-down";
    return `<span class="delta-chip">${d.label} <b>${Math.round(d.a)}→${Math.round(d.b)}</b> <span class="${cls}">(${sign}${Math.round(diff)})</span></span>`;
  }).join("");
  els.comparePanel.hidden = false;
  els.comparePanel.innerHTML = `
    <h3>🔍 比較：${fmtDate(a.date)} → ${fmtDate(b.date)}</h3>
    <div class="compare-grid">
      <div class="compare-col">${img(a)}<div class="cap">${fmtDate(a.date)}${a.tag ? " ・" + a.tag : ""}</div></div>
      <div class="compare-col">${img(b)}<div class="cap">${fmtDate(b.date)}${b.tag ? " ・" + b.tag : ""}</div></div>
    </div>
    <div class="compare-deltas">${deltas}</div>`;
}

// 推移グラフ（依存ライブラリなしのSVG折れ線）
const TAG_COLOR = { "朝": "#f0a93b", "昼": "#4a9fe0", "夜": "#7a5ad0" };
function metricValue(r, key) {
  if (key === "smileBalance") return smileBalance(r);
  return r[key];
}
function renderChart() {
  const arr = loadRecords().slice().reverse(); // 古い→新しい
  if (arr.length < 2) { els.trend.hidden = true; return; }
  els.trend.hidden = false;
  const key = els.trendMetric.value;
  const vals = arr.map((r) => metricValue(r, key)).filter((v) => isFinite(v));
  if (vals.length < 2) { els.trend.hidden = true; return; }

  const W = Math.max(320, arr.length * 46), H = 160, pad = { l: 34, r: 12, t: 12, b: 24 };
  let min = Math.min(...vals), max = Math.max(...vals);
  if (key === "sym") { min = Math.min(min, 70); max = 100; }
  else if (key === "eyeAsym" || key === "mouthAsym") { min = 0; max = Math.max(max, 20); }
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (arr.length - 1);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  const grid = [0, 0.5, 1].map((f) => {
    const v = min + (max - min) * (1 - f);
    const yy = pad.t + f * (H - pad.t - pad.b);
    return `<line x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}" stroke="#e6e8f0"/>
            <text x="2" y="${yy + 3}" font-size="9" fill="#9aa1b2">${Math.round(v)}</text>`;
  }).join("");
  const line = arr.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(metricValue(r, key)).toFixed(1)}`).join(" ");
  const dots = arr.map((r, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(metricValue(r, key)).toFixed(1)}" r="4" fill="${TAG_COLOR[r.tag] || "#e86a92"}"><title>${fmtDate(r.date)}${r.tag ? " " + r.tag : ""}: ${Math.round(metricValue(r, key))}</title></circle>`
  ).join("");
  els.chart.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${grid}
      <path d="${line}" fill="none" stroke="#e86a92" stroke-width="2"/>
      ${dots}
    </svg>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

els.showMesh.addEventListener("change", () => { if (mode === "photo" && latest) {/* 次検出時反映 */} });

// ---------- 起動 ----------
refreshRecordUI();
switchMode("camera");
initLandmarker();
