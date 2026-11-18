import {
  FaceLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/vision_bundle.mjs";

// ===== 設定 =====
const GEMINI_MODEL = "gemini-flash-lite-latest"; // 既定は軽量・高速モデル（遅い/404時は自動で切替）
const MODEL_STORE = "hyojokin-gemini-model";
const KEY_STORE = "hyojokin-gemini-key";
const STORE_KEY = "hyojokin-records-v1";

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const els = {
  video: $("webcam"), still: $("still"), canvas: $("overlay"), stageMsg: $("stage-message"),
  modeTabs: [...document.querySelectorAll(".mode-tab")],
  startCam: $("startCam"), shutter: $("shutter"), retake: $("retake"), mirror: $("mirror"),
  camGroup: document.querySelector('.control-group[data-for="camera"]'),
  photoGroup: document.querySelector('.control-group[data-for="photo"]'),
  videoGroup: document.querySelector('.control-group[data-for="video"]'),
  photoInput: $("photoInput"), videoInput: $("videoInput"), clip: $("clip"),
  analyzeBtn: $("analyzeBtn"), showMesh: $("showMesh"), savePhoto: $("savePhoto"),
  conditionMode: $("conditionMode"), conditionNote: $("conditionNote"),
  adviceCard: $("adviceCard"), advice: $("advice"), copyAdvice: $("copyAdvice"),
  adviceActions: $("adviceActions"), reshootBtn: $("reshootBtn"), aiScores: $("aiScores"),
  summaryCard: $("summaryCard"), summary: $("summary"),
  apiKey: $("apiKey"), saveKey: $("saveKey"), keyStatus: $("keyStatus"), settings: $("settings"),
  saveBtn: $("saveBtn"), clearBtn: $("clearBtn"), history: $("history"),
  tagBtns: $("tagBtns"), noteInput: $("noteInput"),
  trend: $("trend"), trendMetric: $("trendMetric"), chart: $("chart"),
  comparePanel: $("comparePanel"), historyHint: $("historyHint"),
};
const ctx = els.canvas.getContext("2d");

// ===== state =====
let faceLandmarker = null, drawingUtils = null, mode = "camera", stream = null;
let latest = null;            // 直近の測定結果
let currentDataUrl = null;    // 分析対象の静止画(JPEG dataURL)
let currentLandmarks = null;  // 直近のランドマーク
let currentTag = "朝", picked = [];
let sessionLog = [];          // この練習セッションの各回 {sym,eyeAsym,mouthAsym,tension,neck,neutral}
let prevAdvice = "";          // 前回AIが伝えた本文（繰り返し防止用）
let lastScores = null;        // 直近AIの使い方スコア {tension,neck,neutral}
let videoFrames = [];         // 動画から切り出したコマ(JPEG dataURL配列)

function setMsg(t) {
  if (!t) els.stageMsg.classList.add("hidden");
  else { els.stageMsg.textContent = t; els.stageMsg.classList.remove("hidden"); }
}

// ===== MediaPipe =====
async function initLandmarker() {
  setMsg("顔測定モデルを読み込み中…");
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm");
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "IMAGE", numFaces: 1,
    });
    drawingUtils = new DrawingUtils(ctx);
    setMsg("準備完了。カメラを開始するか、写真を選んでください。");
  } catch (e) {
    console.error(e);
    setMsg("モデル読み込みに失敗。通信環境を確認して再読み込みしてください。");
  }
}

// ===== モード切替 =====
els.modeTabs.forEach((t) => t.addEventListener("click", () => switchMode(t.dataset.mode)));
function switchMode(next) {
  mode = next;
  els.modeTabs.forEach((t) => t.classList.toggle("is-active", t.dataset.mode === next));
  els.camGroup.hidden = next !== "camera";
  els.photoGroup.hidden = next !== "photo";
  els.videoGroup.hidden = next !== "video";
  stopCamera();
  resetStill();
  setCamUI("idle");
  if (next === "camera") { els.video.hidden = false; setMsg("「📷 カメラを開始」を押してください。"); }
  else if (next === "video") { els.video.hidden = true; setMsg("「動画を選ぶ」から、普段話している動画をアップしてください。"); }
  else { els.video.hidden = true; setMsg("「写真を選ぶ」から顔写真をアップしてください。"); }
}

function resetStill() {
  currentDataUrl = null; currentLandmarks = null; latest = null; videoFrames = [];
  els.still.hidden = true; els.still.src = "";
  els.canvas.hidden = true;
  clearCanvas();
  els.analyzeBtn.disabled = true;
  els.summaryCard.hidden = true;
  els.adviceCard.hidden = true;
  els.adviceActions.hidden = true;
  els.aiScores.hidden = true; els.aiScores.innerHTML = "";
  lastScores = null;
  els.retake.hidden = true;
}

// ===== カメラ =====
els.startCam.addEventListener("click", startCamera);
els.shutter.addEventListener("click", takeShot);
els.retake.addEventListener("click", startCamera); // 撮り直す＝ライブに戻す
els.mirror.addEventListener("change", () => els.video.classList.toggle("mirror", els.mirror.checked));
els.video.classList.toggle("mirror", els.mirror.checked);

// カメラのボタン表示は常に1つだけ： idle | live | captured
function setCamUI(state) {
  els.startCam.hidden = state !== "idle";
  els.shutter.hidden = state !== "live";
  els.retake.hidden = state !== "captured";
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    els.video.srcObject = stream;
    await els.video.play();
    resetStill();           // 前の静止画・結果をクリア
    els.video.hidden = false;
    setMsg("");
    setCamUI("live");
  } catch (e) {
    console.error(e);
    setMsg("カメラを使えませんでした。ブラウザのカメラ許可を確認してください。");
  }
}
function stopCamera() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  els.video.srcObject = null;
}

function takeShot() {
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  if (!vw) return;
  const c = document.createElement("canvas");
  c.width = vw; c.height = vh;
  const cx = c.getContext("2d");
  if (els.mirror.checked) { cx.translate(vw, 0); cx.scale(-1, 1); }
  cx.drawImage(els.video, 0, 0, vw, vh);
  const url = c.toDataURL("image/jpeg", 0.85);
  stopCamera();
  els.video.hidden = true;
  showStill(url);
  setCamUI("captured");
}

// ===== 写真アップ =====
els.photoInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => showStill(reader.result);
  reader.readAsDataURL(file);
});

// ===== 話す動画アップ → コマを切り出す =====
els.videoInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  extractFrames(file);
});

async function extractFrames(file) {
  resetStill();
  setMsg("動画からコマを切り出しています…");
  const url = URL.createObjectURL(file);
  const v = els.clip;
  v.src = url; v.muted = true;
  try {
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error("load"));
    });
    const dur = v.duration && isFinite(v.duration) ? v.duration : 0;
    // 最初と最後を少し避けて、話している中盤から等間隔に5コマ
    const n = 5;
    const start = dur ? dur * 0.12 : 0, end = dur ? dur * 0.88 : 0;
    const times = dur ? Array.from({ length: n }, (_, i) => start + (end - start) * (i / (n - 1))) : [0];
    const vw = v.videoWidth || 640, vh = v.videoHeight || 480;
    const scale = Math.min(1, 720 / Math.max(vw, vh));
    const cw = Math.round(vw * scale), ch = Math.round(vh * scale);
    const c = document.createElement("canvas"); c.width = cw; c.height = ch;
    const cx = c.getContext("2d");
    const frames = [];
    for (const t of times) {
      await seekTo(v, t);
      cx.drawImage(v, 0, 0, cw, ch);
      frames.push(c.toDataURL("image/jpeg", 0.8));
    }
    URL.revokeObjectURL(url);
    videoFrames = frames;
    // 代表コマ（中央）を測定・表示に使う
    const mid = frames[Math.floor(frames.length / 2)] || frames[0];
    setMsg("");
    showStill(mid);
  } catch (err) {
    console.error(err);
    URL.revokeObjectURL(url);
    setMsg("この動画を読み込めませんでした。別の形式（mp4など）や短いクリップでお試しください。");
  }
}

function seekTo(v, t) {
  return new Promise((res) => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    try { v.currentTime = Math.min(t, (v.duration || t)); } catch { res(); }
  });
}

// ===== 静止画を表示→測定 =====
function showStill(dataUrl) {
  currentDataUrl = dataUrl;
  els.still.onload = () => { setMsg(""); processStill(); };
  els.still.src = dataUrl;
  els.still.hidden = false;
}

function processStill() {
  if (!faceLandmarker) return;
  sizeCanvasTo(els.still.naturalWidth, els.still.naturalHeight);
  const res = faceLandmarker.detect(els.still);
  clearCanvas();
  if (!res.faceLandmarks?.length) {
    latest = null; els.summaryCard.hidden = true;
    if (videoFrames.length) { els.analyzeBtn.disabled = false; setMsg(""); }  // 動画はコマ全体でAIが分析できる
    else { setMsg("顔を検出できませんでした。正面の写真でお試しください。"); els.analyzeBtn.disabled = true; }
    return;
  }
  const lm = res.faceLandmarks[0];
  currentLandmarks = lm;
  if (els.showMesh.checked) { els.canvas.hidden = false; drawMesh(lm); }
  const w = els.canvas.width, h = els.canvas.height;
  latest = computeMetrics(lm, w, h);
  renderSummary(latest);
  els.analyzeBtn.disabled = false;
}

els.showMesh.addEventListener("change", () => {
  if (!currentLandmarks) return;
  if (els.showMesh.checked) { els.canvas.hidden = false; clearCanvas(); drawMesh(currentLandmarks); }
  else { els.canvas.hidden = true; clearCanvas(); }
});

function sizeCanvasTo(w, h) { if (w && h) { els.canvas.width = w; els.canvas.height = h; } }
function clearCanvas() { ctx.clearRect(0, 0, els.canvas.width, els.canvas.height); }

// ===== 幾何計算 =====
const px = (lm, i, w, h) => ({ x: lm[i].x * w, y: lm[i].y * h });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function makeRotator(lm, w, h) {
  const r = px(lm, 33, w, h), l = px(lm, 263, w, h);
  const cx = (r.x + l.x) / 2, cy = (r.y + l.y) / 2;
  const ang = Math.atan2(l.y - r.y, l.x - r.x), cos = Math.cos(-ang), sin = Math.sin(-ang);
  return (i) => { const p = px(lm, i, w, h), dx = p.x - cx, dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }; };
}
const asymPct = (a, b) => { const m = Math.max(Math.abs(a), Math.abs(b)) || 1; return Math.min(100, Math.abs(a - b) / m * 100); };

function computeMetrics(lm, w, h) {
  const R = makeRotator(lm, w, h);
  const io = dist(R(33), R(263)) || 1;
  const eyeA = dist(R(159), R(145)) / io, eyeB = dist(R(386), R(374)) / io;
  const aIsRight = R(33).x < R(263).x;
  const eyeRight = aIsRight ? eyeA : eyeB, eyeLeft = aIsRight ? eyeB : eyeA;
  const eyeAsym = asymPct(eyeLeft, eyeRight);
  const mcY = (R(13).y + R(14).y) / 2;
  const cA = R(61), cB = R(291);
  const liftA = (mcY - cA.y) / io, liftB = (mcY - cB.y) / io;
  const cAR = cA.x < cB.x;
  const mouthRight = cAR ? liftA : liftB, mouthLeft = cAR ? liftB : liftA;
  const mouthAsym = asymPct(mouthLeft + 0.5, mouthRight + 0.5);
  const sym = symmetryScore(R, io);
  return { date: new Date().toISOString(), eyeLeft, eyeRight, eyeAsym, mouthLeft, mouthRight, mouthAsym, sym };
}
const SYM_PAIRS = [[33, 263], [133, 362], [61, 291], [234, 454], [105, 334], [58, 288]];
function symmetryScore(R, scale) {
  const midX = (R(168).x + R(1).x + R(164).x) / 3;
  let err = 0;
  for (const [ri, li] of SYM_PAIRS) {
    const a = R(ri), b = R(li);
    const L = a.x < b.x ? a : b, Rr = a.x < b.x ? b : a;
    err += (Math.abs((midX - L.x) - (Rr.x - midX)) + Math.abs(a.y - b.y)) / scale;
  }
  err /= SYM_PAIRS.length;
  return Math.max(0, Math.min(100, Math.round(100 - err * 220)));
}

function drawMesh(lm) {
  const C = FaceLandmarker;
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_TESSELATION, { color: "rgba(255,255,255,0.2)", lineWidth: 0.5 });
  const op = { color: "rgba(232,106,146,0.6)", lineWidth: 1.5 };
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_RIGHT_EYE, op);
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_LEFT_EYE, op);
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_LIPS, op);
  drawingUtils.drawConnectors(lm, C.FACE_LANDMARKS_FACE_OVAL, { color: "rgba(255,255,255,0.4)", lineWidth: 1 });
}

// ===== 測定サマリー（静的表示） =====
function renderSummary(m) {
  const eyeDir = m.eyeAsym < 6 ? "ほぼ左右対称" : (m.eyeRight < m.eyeLeft ? "右目がやや小さめ" : "左目がやや小さめ");
  const mouthDir = m.mouthAsym < 8 ? "ほぼ左右対称" : (m.mouthRight < m.mouthLeft ? "右の口角がやや下がり" : "左の口角がやや下がり");
  const cond = els.conditionMode.checked;  // 医療配慮モードでは左右差を“警告”で出さない
  const items = [
    ["顔の左右対称", `${m.sym} / 100`, cond ? "" : m.sym >= 90 ? "good" : m.sym >= 80 ? "" : "warn"],
    ["目の開き", `左右差 ${m.eyeAsym.toFixed(0)}%・${eyeDir}`, cond ? "" : m.eyeAsym < 10 ? "good" : m.eyeAsym < 20 ? "" : "warn"],
    ["口角の高さ", `左右差 ${m.mouthAsym.toFixed(0)}%・${mouthDir}`, cond ? "" : m.mouthAsym < 12 ? "good" : m.mouthAsym < 25 ? "" : "warn"],
  ];
  els.summary.innerHTML = items.map(([k, v, c]) =>
    `<div class="sum-item"><span class="sum-k">${k}</span><span class="sum-v ${c}">${v}</span></div>`).join("");
  els.summaryCard.hidden = false;
}

function summaryText(m) {
  const eyeDir = m.eyeAsym < 6 ? "ほぼ左右対称" : (m.eyeRight < m.eyeLeft ? "右目がやや小さい/開きが弱い" : "左目がやや小さい/開きが弱い");
  const mouthDir = m.mouthAsym < 8 ? "ほぼ左右対称" : (m.mouthRight < m.mouthLeft ? "右の口角が左より下がっている" : "左の口角が右より下がっている");
  return [
    `・顔の左右対称スコア: ${m.sym}/100（100に近いほど対称）`,
    `・目の開きの左右差: ${m.eyeAsym.toFixed(0)}%（${eyeDir}）`,
    `・口角の高さの左右差: ${m.mouthAsym.toFixed(0)}%（${mouthDir}）`,
  ].join("\n");
}

// AIに毎回つけてもらう集計用スコア行（画面には出さず、記録・グラフ用に解析）
const SCORE_LINE = `

最後に、画面には表示しない集計用の行を必ず1行だけ、次の形式そのままで付けてください（前後に文章や記号を付けない）:
@@SCORES tension=[0-10の整数] neck=[0-10の整数] neutral=[0-10の整数]
意味: tension=口元・顎まわりの力み(0=完全に脱力, 10=強く力む／低いほど良い)、neck=首・フェイスラインの緊張(0=ゆるむ, 10=強い緊張／低いほど良い)、neutral=脱力ニュートラルのできている度合い(0=できていない, 10=理想的／高いほど良い)。写真から素直に評価してください。`;

// ===== APIキー =====
function getKey() { try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; } }
function reflectKey() {
  const k = getKey();
  els.keyStatus.textContent = k ? "✓ 保存済み" : "未設定";
  els.keyStatus.className = "key-status " + (k ? "ok" : "");
  if (k) els.apiKey.placeholder = "保存済み（変更する場合のみ入力）";
}
els.saveKey.addEventListener("click", () => {
  const v = els.apiKey.value.trim();
  if (!v) { alert("キーを入力してください。"); return; }
  try { localStorage.setItem(KEY_STORE, v); } catch {}
  els.apiKey.value = "";
  reflectKey();
  els.settings.open = false;
});

// ===== プロンプト =====
function buildPrompt(m) {
  return `あなたは表情筋・顔のバランスのセルフケアを支える、やさしく具体的なコーチです。医師ではなく、診断はしません。

相手は、顎・舌・首の脱力をベースに表情筋を整える取り組みをしています。前提となる考え方:
- 舌を上あごにふんわり吸着・奥歯を離す・オトガイ(下唇/顎先)を脱力する3ステップでニュートラルを作る(この「3-1-2」という呼び名やステップ番号は内部用語なので、回答には絶対に書かないこと)。
- 笑うとき、口角を「真横・奥」へ引く代償(笑筋・頬筋・首の広頚筋)が癖になりやすい。理想は、頬のトップ(大頬骨筋)を斜め上に持ち上げ、目元がゆるむ笑顔。
- 「口角そのものを引き上げている」のか「頬の筋肉で持ち上げている」のかを見分けたい。
- 下顎を大きく動かす会話は咀嚼筋〜首を引っ張る。首の縦スジ(広頚筋)・口角横の深い溝・下唇の巻き込み・目の開きの左右差・朝夜での変化に注目。

この顔写真を見て、上の観点で観察してください。アプリによる客観測定値(参考):
${summaryText(m)}

次の構成で、あたたかく具体的に、日本語で答えてください。専門用語には短い補足を。長すぎないように。トーンは落ち着いて正直に——ほめ言葉は大げさにせず控えめに(多くても1〜2回)、お世辞っぽくしない。
1. **いま見えること** — どこがどう引っ張られている/力んでいるか、左右差、口角か頬か、首や顎の緊張の兆候を、写真に即して具体的に(断定しすぎず「〜に見えます」)。
2. **なぜそうなりやすいか** — 1〜2文で簡単に。
3. **今日ためしてみて** — 「まず、順番にやってみましょう」のようにやさしく導入し(「3-1-2」等の名称や番号は出さない)、すぐその場でできる「動き」を上から順に。各手順は先頭に番号(1. 2. 等)を付けず、「**舌のポジションを整える**」のような太字の小見出し＋短い説明の形で並べてください。必ず次を“動かし方・置き方”として具体的に含めてください:
   - **舌の位置**: 舌先を上の前歯の少し後ろ(スポット)に置き、舌全体を上あごへふんわり吸い上げる(軽い陰圧)。どのくらいの力か・どこに当てるかを言葉で。
   - **奥歯**: 上下の奥歯を1〜2mm離して噛み締めをオフにする。
   - **オトガイ(下唇・顎先)**: 力をスッと抜く。
   写真で気になった部分(例:右の口角・首の緊張)に合わせて、手の当て方や目元・頬の動かし方も1つ添える。鼻呼吸や姿勢のひとことも歓迎。
最後に、はげましの一言とともに「いまの助言どおりに舌の位置や頬の使い方を整えて、もう一度撮って見比べてみましょう」と、やさしく“もう一枚撮って練習する”ことを促してください。
重要: 「3-1-2」という語句や数字の並び(3-1-2 / 3,1,2 等)は、名称・見出し・本文のどこにも絶対に出力しないこと。${SCORE_LINE}`;
}

// 2回目以降（撮り直し）用：これまでの流れをふまえ、毎回ちがう切り口で深掘りするコーチ
function buildFollowupPrompt(log, now, prevAdvice) {
  const journey = log.map((s, i) =>
    `${i + 1}回目: 対称${s.sym}・目の差${Math.round(s.eyeAsym)}%・口角差${Math.round(s.mouthAsym)}%` +
    (isFinite(s.tension) ? `・力み${s.tension}/首${s.neck}/ニュートラル${s.neutral}` : "")
  ).join("\n");
  const n = log.length + 1;
  return `あなたは、顔・顎・舌・首の連動に精通したベテランのセルフケア指導者です(鍼灸・解剖学の視点も持つ)。医師ではなく診断はしません。前提の考え方:
- 顎関節・奥歯・舌と、首の深層筋(胸鎖乳突筋・斜角筋・肩甲挙筋・後頭下筋群)は一つのユニットとして連動する。
- 舌(インナー)の支えが弱いと下顎が不安定になり、奥歯や耳周り・首で踏ん張って支えてしまう。舌が上あごに吸着して土台ができると、噛みしめや首の力みが抜けやすい。
- 理想の笑顔は、口角を横に引く(笑筋・広頚筋)のではなく、頬のトップ(大頬骨筋)を斜め上に上げ、目元がゆるむ。
- 力みが抜けると、頭蓋底や目の奥の締め付けがゆるみ、目の開き・左右差・フェイスラインが整う。

これは同じ人が【練習しながら何度も撮り直している、${n}回目の一枚】です。毎回ちがう気づきを与え、飽きさせず、少しずつ深めてください。

この練習セッションのこれまでの流れ:
${journey}
今回の測定値:
${summaryText(now)}
${prevAdvice ? `\n前回あなたが伝えた内容(今回はこれと同じ助言・同じ言い回しを繰り返さないこと):\n「${prevAdvice.slice(0, 350)}」\n` : ""}
守ること:
- 短めに、あたたかく、でも毎回“新鮮”に。お世辞や大げさな称賛はしない。
- 冒頭1文: これまでの流れをふまえた変化の見立て(数値も少し使う。ほぼ同じなら「この良い状態を体に覚えさせる段階」と捉える)。
- 本題: 【今回はひとつの切り口だけ】を選んで深掘りする。切り口は回ごとに必ず変えること。候補例: 舌の吸着の精度／奥歯のゆるめ方／オトガイ(下唇・顎先)／頬を斜め上に上げる感覚／首・肩・後頭部の脱力／鼻呼吸／目線と姿勢／会話や噛みしめの無意識の癖／"今の整った感覚"の覚え方・再現のコツ。前回と違う切り口を選ぶ。
- その切り口について「なぜ効くのか」の仕組みを一文そえて、学びになるように。具体的な動き・手の当て方など、その場でできる形で。
- 最後に、次に意識するとよい一点を一言。${n >= 3 ? "（今回は、静止画だけでなく『普段 話している様子』を動画で撮って見てみることも、さりげなく勧めてよい。会話時の顎や首の使い方は動画でこそ分かるため）" : ""}
番号(1. 2.)は付けず、必要なら短い太字の小見出しで。「3-1-2」という語句や数字の並びは出さない。${SCORE_LINE}`;
}

// 医療的な左右差（麻痺・斜視など）に配慮したプロンプト
function buildConditionPrompt(note, { isVideo, log, prevAdvice }) {
  const cond = note ? `この方には医療的な状態があります:「${note}」。` : `この方の顔の左右差には、医療的な要因(神経の麻痺・斜視など)が背景にある可能性があります。`;
  return `あなたは、顔・顎・首のケアに詳しい、やさしく丁寧なセルフケアの伴走者です。医師ではなく、診断や治療はしません。

${cond}
【厳守する前提】
- 顔の左右差を「本人の悪い癖」「サボり」のように扱わない。決して責めない。
- 麻痺している側の筋肉を「もっと動かして」と無理に促さない(動かせないことがある)。左右差を「矯正して直す」という言い方をしない。
- その代わり、本人が“ラクにできること”に焦点を当てる: 首・肩・あご・こめかみ・健側(よく動く側)の【使いすぎ・凝り・こわばり・力み】をゆるめる、血流をうながす、やさしいケア(温める・そっとさする・脱力・ゆっくりした鼻呼吸)。これはあなた(鍼灸等)の得意分野として前向きに。
- 症状そのものの回復・治療は、必ず「担当の先生の治療やリハビリと一緒に」「指導のもとで」と添える。
- あたたかく、希望を奪わず、できていることも拾う。短めに。

${isVideo ? "以下は普段 話している様子を動画から切り出した連続コマです。会話時の緊張や使いすぎに注目。" : "この顔写真を見てください。"}
${log && log.length ? "これまでの経過(対称スコア): " + log.map((s, i) => `${i + 1}回目 ${s.sym}`).join(" / ") + "\n" : ""}${prevAdvice ? "前回の内容(同じことは繰り返さない):「" + prevAdvice.slice(0, 220) + "」\n" : ""}
次の構成で、日本語でやさしく、でも“前向きで希望が持てる”トーンで答えてください(番号は付けない、「3-1-2」という語句は出さない):
- **いいところ・気になるところ** — まず、写真から見える良い点・できていること(穏やかな表情、健側の動き、ゆるんでいる所など)を必ず一つ拾って、具体的に認める。そのうえで、緊張・凝り・こわばりが出ていそうな所(首・肩・あご・こめかみ・健側の使いすぎ)を責めずにそっと。左右差には「医療的な要因が背景にあるかもしれません」とやわらかく。
- **今日のケア** — その場でできる“ゆるめる系”を1〜2個(どこを・どうやさしく)。温め／さすり／脱力／呼吸など。無理に動かす指示はしない。やってみたくなるよう具体的に。
- **続けると** — このケアを重ねると期待できることを、希望が持てる形で一言(断定せず「こわばりが和らいで、表情が動かしやすく感じられることもあります」のように)。小さな変化も一緒に見ていける、また試したくなる前向きな締めに。「担当の先生の治療やリハビリと一緒に、できる範囲で」も添える。${SCORE_LINE}`;
}

// 話す動画（連続コマ）用プロンプト
function buildVideoPrompt() {
  return `あなたは、顔・顎・舌・首の連動に精通したベテランのセルフケア指導者です(鍼灸・解剖学の視点も持つ)。医師ではなく診断はしません。

以下の複数枚は、ある人が【普段 話している様子】を動画から時系列に切り出した連続コマです。1枚ずつではなく"話している最中の動き"として見てください。会話で下顎を大きく動かすと咀嚼筋から首(広頚筋など)まで引っ張られやすい、という観点が大切です。

次の観点で観察してください:
- 話すときに口角を横へ引く癖(笑筋・広頚筋)が出ていないか、左右で引っ張られ方に差はないか。
- 下顎の動きが大きすぎないか(舌と唇の小さな動きで話せると負担が減る)。
- 首の縦スジ・顎下・フェイスラインに緊張が出ていないか。
- 目元や頬のこわばり。

次の構成で、あたたかく具体的に、短めに答えてください(お世辞は控えめ、番号は付けず必要なら太字の小見出し、「3-1-2」という語句は出さない):
- **話しているときの様子** — コマ全体から読み取れる、話す瞬間の顔・顎・首の使い方の特徴(左右差や癖を具体的に、断定しすぎず)。
- **なぜそうなりやすいか** — 1〜2文で仕組みを。
- **会話のときに試してみて** — 下顎を大きく動かさず、舌先と唇の軽い動きで話す等、その場で意識できる具体策を1〜2個。舌の支えや奥歯のゆるめ方にも触れてよい。
最後に「意識しながら少し話して、また撮ってみましょう」とやさしく促してください。${SCORE_LINE}`;
}

// ===== AI分析 =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function callGemini(key, model, body, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctrl.signal }
  ).finally(() => clearTimeout(timer));
}
// 送信用に画像を縮小してbase64化（通信を軽く・安く）
function resizedBase64(maxDim = 1024, quality = 0.85) {
  const iw = els.still.naturalWidth, ih = els.still.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.round(iw * scale), h = Math.round(ih * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(els.still, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality).split(",")[1];
}
// 複数モデルを順に試す（遅い/混雑時は別モデルへ切替、成功したら記憶）
async function getAdvice(key, body) {
  const cached = localStorage.getItem(MODEL_STORE);
  // 軽量・高速モデルを常に最優先。過去キャッシュは後ろに回す
  const candidates = ["gemini-flash-lite-latest", "gemini-2.0-flash", "gemini-2.5-flash-lite", cached, "gemini-flash-latest"];
  const tried = new Set();
  let last = null, timedOut = false;
  for (const model of candidates) {
    if (!model || tried.has(model)) continue;
    tried.add(model);
    for (let t = 0; t < 2; t++) {
      let resp;
      try {
        resp = await callGemini(key, model, body, 30000);
      } catch (e) {
        if (e.name === "AbortError") { timedOut = true; break; } // 遅すぎ→次のモデルへ
        throw e;                                                 // 通信エラーは外へ
      }
      last = resp;
      if (resp.ok) { try { localStorage.setItem(MODEL_STORE, model); } catch {} return resp; }
      if (resp.status === 404) break;                            // 存在しない→次のモデル
      if (resp.status === 503 || resp.status === 500) {          // 混雑→少し待って再試行
        els.advice.innerHTML = `<div class="loading">AIが混み合っています。別のモデルで再試行中…<span class="dots"></span></div>`;
        await sleep(1000 * (t + 1));
        continue;
      }
      return resp;                                               // 400/403/429等はそのまま返す
    }
    if (!last || last.status === 404 || timedOut) {
      els.advice.innerHTML = `<div class="loading">別のAIモデルで試しています…<span class="dots"></span></div>`;
    }
  }
  if (timedOut && !last) { const e = new Error("timeout"); e.name = "AbortError"; throw e; }
  return last;
}

// 使えるモデルを一覧から自動検出（flash優先）
async function pickModel(key) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const d = await r.json();
    const ok = (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
    const pick = ok.find((m) => /flash-lite/.test(m.name))
      || ok.find((m) => /flash/.test(m.name) && !/thinking|exp/.test(m.name))
      || ok.find((m) => /flash/.test(m.name)) || ok[0];
    return pick ? pick.name.replace(/^models\//, "") : null;
  } catch { return null; }
}

// 医療的配慮モードのトグル：メモ欄と注意書きの表示
els.conditionMode.addEventListener("change", () => {
  const on = els.conditionMode.checked;
  els.conditionNote.hidden = !on;
  document.querySelector(".condition-hint").hidden = !on;
});

els.analyzeBtn.addEventListener("click", analyzeWithAI);
async function analyzeWithAI() {
  if (videoFrames.length === 0 && (!latest || !currentDataUrl)) { alert("先に顔を撮影/選択してください。"); return; }
  const key = getKey();
  if (!key) {
    alert("先に「⚙️ AIの設定」でGeminiのAPIキーを保存してください。");
    els.settings.open = true; return;
  }
  const isVideo = videoFrames.length > 0;
  const isFollowup = !isVideo && sessionLog.length > 0;
  els.adviceCard.hidden = false;
  els.adviceActions.hidden = true;
  els.advice.innerHTML = `<div class="loading">${isVideo ? "話している様子を分析しています" : isFollowup ? "これまでの流れと見比べています" : "AIが顔を見ています"}…<span class="dots"></span></div>`;
  els.analyzeBtn.disabled = true;
  try {
    const prompt = els.conditionMode.checked
      ? buildConditionPrompt(els.conditionNote.value.trim(), { isVideo, log: sessionLog, prevAdvice })
      : isVideo ? buildVideoPrompt()
      : isFollowup ? buildFollowupPrompt(sessionLog, latest, prevAdvice)
      : buildPrompt(latest);
    const parts = [{ text: prompt }];
    if (isVideo) {
      for (const f of videoFrames) parts.push({ inline_data: { mime_type: "image/jpeg", data: f.split(",")[1] } });
    } else {
      parts.push({ inline_data: { mime_type: "image/jpeg", data: resizedBase64() } });
    }
    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1000 },
    });
    const resp = await getAdvice(key, body);
    if (!resp || !resp.ok) {
      const status = resp ? resp.status : 0;
      const err = resp ? await resp.text().catch(() => "") : "";
      let msg = `エラー (${status || "通信"})`;
      if (status === 400 && /API key|API_KEY/i.test(err)) msg = "APIキーが正しくないようです。設定を確認してください。";
      else if (status === 429) msg = "回数制限に達しました。少し時間をおいて再度お試しください（Gemini無料枠の上限です）。";
      else if (status === 403) msg = "このキーではGemini APIが有効になっていないようです。AI Studioでキーを作り直してみてください。";
      else if (status === 404) msg = "利用できるモデルが見つかりませんでした。少し時間をおくか、キーを作り直してみてください。";
      else if (status === 503 || status === 500) msg = "今どのAIモデルも混み合っているようです。1〜2分おいて、もう一度「AIに分析してもらう」を押してください。";
      els.advice.innerHTML = `<p class="err">${msg}</p>`;
      console.error("Gemini error", status, err);
      return;
    }
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (!text) { els.advice.innerHTML = `<p class="err">回答を取得できませんでした。もう一度お試しください。</p>`; return; }
    // 集計用スコア行を抽出して本文からは取り除く
    const sm = text.match(/@@SCORES\s+tension=(\d+)\s+neck=(\d+)\s+neutral=(\d+)/i);
    lastScores = sm ? { tension: +sm[1], neck: +sm[2], neutral: +sm[3] } : null;
    const clean = text.replace(/\n*@@SCORES[^\n]*/i, "").trim();
    els.advice.innerHTML = miniMarkdown(clean);
    els.advice.dataset.raw = clean;
    renderScores(lastScores);
    els.adviceActions.hidden = false;
    // 静止画の練習は、この回をセッション履歴に積む（次回はこれまでの流れをふまえて話す）
    if (!isVideo && latest) {
      sessionLog.push({ sym: latest.sym, eyeAsym: latest.eyeAsym, mouthAsym: latest.mouthAsym, ...(lastScores || {}) });
      if (sessionLog.length > 8) sessionLog.shift();
      prevAdvice = clean;
    }
  } catch (e) {
    console.error(e);
    const msg = e.name === "AbortError"
      ? "時間がかかりすぎました。電波の良い場所で、もう一度「AIに分析してもらう」を押してください。"
      : "通信に失敗しました。接続を確認して再度お試しください。";
    els.advice.innerHTML = `<p class="err">${msg}</p>`;
  } finally {
    els.analyzeBtn.disabled = false;
  }
}

// アドバイスを受けて、舌・表情を整えてもう一度撮る（練習ループ）
els.reshootBtn.addEventListener("click", async () => {
  if (mode !== "camera") switchMode("camera");
  await startCamera();
  els.stageMsg && setMsg("");
  document.querySelector(".stage-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

els.copyAdvice.addEventListener("click", async () => {
  const t = els.advice.dataset.raw || els.advice.textContent;
  try { await navigator.clipboard.writeText(t); els.copyAdvice.textContent = "コピーしました"; setTimeout(() => (els.copyAdvice.textContent = "コピー"), 1500); } catch {}
});

// AIの使い方スコアをチップ表示（すべて「高いほど良い」に統一）
function renderScores(s) {
  if (!s) { els.aiScores.hidden = true; els.aiScores.innerHTML = ""; return; }
  const chip = (label, val) => {  // val: 0〜10、高いほど良い
    const good = val >= 7, warn = val <= 3;
    const word = good ? "良い" : warn ? "あと少し" : "ふつう";
    const cls = good ? "good" : warn ? "warn" : "";
    return `<span class="score-chip ${cls}"><span class="score-k">${label}</span> <b>${val}</b><small>/10</small> <span class="score-word">${word}</span></span>`;
  };
  els.aiScores.innerHTML = `<span class="scores-title">AI評価（高いほど良い）</span>`
    + chip("口元のゆるみ", 10 - s.tension)
    + chip("首のラクさ", 10 - s.neck)
    + chip("ニュートラル", s.neutral);
  els.aiScores.hidden = false;
}

// ごく簡易なMarkdown→HTML
function miniMarkdown(src) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const lines = esc(src).split("\n");
  let html = "", inUl = false, inOl = false, olNum = 0;
  const closeLists = () => { if (inUl) { html += "</ul>"; inUl = false; } if (inOl) { html += "</ol>"; inOl = false; } };
  for (let line of lines) {
    line = line.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (/^#{1,4}\s+/.test(line)) { closeLists(); olNum = 0; html += `<h4>${line.replace(/^#{1,4}\s+/, "")}</h4>`; continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    const ul = line.match(/^\s*(?:[-*]\s+|[・•]\s*)(.*)/);
    // 段落で区切られても連番を継続（値を明示）。見出しでのみリセット
    if (ol) { if (!inOl) { closeLists(); html += `<ol>`; inOl = true; } html += `<li value="${++olNum}">${ol[1]}</li>`; continue; }
    if (ul) { if (!inUl) { closeLists(); html += "<ul>"; inUl = true; } html += `<li>${ul[1]}</li>`; continue; }
    closeLists();
    if (line.trim() === "") continue;
    html += `<p>${line}</p>`;
  }
  closeLists();
  return html;
}

// ===== 記録 =====
function loadRecords() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; } }
function saveRecords(arr) { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); }
els.tagBtns.addEventListener("click", (e) => {
  const b = e.target.closest(".tag-btn"); if (!b) return;
  currentTag = b.dataset.tag;
  els.tagBtns.querySelectorAll(".tag-btn").forEach((x) => x.classList.toggle("is-active", x === b));
});

function thumbFromStill() {
  try {
    if (!currentDataUrl) return null;
    const tw = 220, th = Math.round((els.still.naturalHeight / els.still.naturalWidth) * tw);
    const c = document.createElement("canvas"); c.width = tw; c.height = th;
    c.getContext("2d").drawImage(els.still, 0, 0, tw, th);
    return c.toDataURL("image/jpeg", 0.6);
  } catch { return null; }
}

els.saveBtn.addEventListener("click", () => {
  if (!latest) { alert("先に顔を撮影/選択してください。"); return; }
  const rec = { ...latest, ...(lastScores || {}), tag: currentTag, note: els.noteInput.value.trim(),
    thumb: els.savePhoto.checked ? thumbFromStill() : null,
    advice: els.advice.dataset.raw || "" };
  const arr = loadRecords(); arr.unshift(rec);
  try { saveRecords(arr); }
  catch { rec.thumb = null; saveRecords(arr); alert("保存容量がいっぱいのため、写真なしで記録しました。"); }
  els.noteInput.value = "";
  refreshRecordUI();
});
els.clearBtn.addEventListener("click", () => {
  if (confirm("記録をすべて削除します。よろしいですか？")) { saveRecords([]); picked = []; refreshRecordUI(); }
});
els.trendMetric.addEventListener("change", renderChart);

const fmtDate = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function refreshRecordUI() { renderHistory(); renderChart(); renderCompare(); }

function renderHistory() {
  const arr = loadRecords();
  els.historyHint.hidden = arr.length < 2;
  els.history.innerHTML = "";
  arr.forEach((r) => {
    const item = document.createElement("div");
    item.className = "hist-item" + (picked.includes(r.date) ? " is-picked" : "");
    const thumb = r.thumb ? `<img class="hist-thumb" src="${r.thumb}" alt="" />` : `<span class="hist-thumb placeholder">👤</span>`;
    const tag = r.tag ? `<span class="hist-tag ${r.tag}">${r.tag}</span>` : "";
    const note = r.note ? `<span class="hist-note">${escapeHtml(r.note)}</span>` : "";
    item.innerHTML = `
      <input type="checkbox" class="hist-pick" ${picked.includes(r.date) ? "checked" : ""} />
      ${thumb}
      <span class="hist-main">
        <span><span class="hist-date">${fmtDate(r.date)}</span>${tag}</span>
        ${note}
        <span class="hist-metrics">
          ${isFinite(r.tension) ? `<span>ゆるみ ${10 - r.tension}</span>` : ""}${isFinite(r.neutral) ? `<span>ニュートラル ${r.neutral}</span>` : ""}<span>対称 ${r.sym}</span>
        </span>
      </span>
      <button class="hist-del" title="削除">✕</button>`;
    item.querySelector(".hist-pick").addEventListener("change", (e) => togglePick(r.date, e.target.checked));
    item.querySelector(".hist-del").addEventListener("click", () => {
      saveRecords(loadRecords().filter((x) => x.date !== r.date));
      picked = picked.filter((p) => p !== r.date); refreshRecordUI();
    });
    els.history.appendChild(item);
  });
}
function togglePick(id, on) {
  if (on) { picked.push(id); if (picked.length > 2) picked.shift(); } else picked = picked.filter((p) => p !== id);
  refreshRecordUI();
}
function renderCompare() {
  if (picked.length !== 2) { els.comparePanel.hidden = true; return; }
  const arr = loadRecords();
  const recs = picked.map((id) => arr.find((r) => r.date === id)).filter(Boolean);
  if (recs.length !== 2) { els.comparePanel.hidden = true; return; }
  recs.sort((a, b) => new Date(a.date) - new Date(b.date));
  const [a, b] = recs;
  const img = (r) => r.thumb ? `<img src="${r.thumb}" alt="" />` : `<div class="hist-thumb placeholder" style="width:100%;height:160px">写真なし</div>`;
  const both = (k) => isFinite(a[k]) && isFinite(b[k]);
  const deltas = [
    ...(both("tension") ? [{ label: "口元のゆるみ", a: 10 - a.tension, b: 10 - b.tension, better: "up" }] : []),
    ...(both("neck") ? [{ label: "首のラクさ", a: 10 - a.neck, b: 10 - b.neck, better: "up" }] : []),
    ...(both("neutral") ? [{ label: "ニュートラル", a: a.neutral, b: b.neutral, better: "up" }] : []),
    { label: "対称スコア", a: a.sym, b: b.sym, better: "up" },
    { label: "目の左右差%", a: a.eyeAsym, b: b.eyeAsym, better: "down" },
    { label: "口角の左右差%", a: a.mouthAsym, b: b.mouthAsym, better: "down" },
  ].map((d) => {
    const diff = d.b - d.a, good = d.better === "up" ? diff > 0 : diff < 0, sign = diff > 0 ? "+" : "";
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
const TAG_COLOR = { "朝": "#f0a93b", "昼": "#4a9fe0", "夜": "#7a5ad0" };
function renderChart() {
  const arr = loadRecords().slice().reverse();
  if (arr.length < 2) { els.trend.hidden = true; return; }
  els.trend.hidden = false;
  const key = els.trendMetric.value;
  const metricOf = (r) =>
    key === "relaxMouth" ? (isFinite(r.tension) ? 10 - r.tension : undefined) :
    key === "relaxNeck" ? (isFinite(r.neck) ? 10 - r.neck : undefined) :
    r[key];
  const pts = arr.filter((r) => isFinite(metricOf(r)));
  const vals = pts.map(metricOf);
  if (vals.length < 2) { els.trend.hidden = true; return; }
  const W = Math.max(320, pts.length * 46), H = 160, pad = { l: 34, r: 12, t: 12, b: 24 };
  let min = Math.min(...vals), max = Math.max(...vals);
  if (key === "sym") { min = Math.min(min, 70); max = 100; }
  else if (key === "relaxMouth" || key === "relaxNeck" || key === "neutral") { min = 0; max = 10; }
  else { min = 0; max = Math.max(max, 20); }
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (pts.length - 1);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const grid = [0, 0.5, 1].map((f) => { const v = min + (max - min) * (1 - f), yy = pad.t + f * (H - pad.t - pad.b);
    return `<line x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}" stroke="#e6e8f0"/><text x="2" y="${yy + 3}" font-size="9" fill="#9aa1b2">${Math.round(v)}</text>`; }).join("");
  const line = pts.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(metricOf(r)).toFixed(1)}`).join(" ");
  const dots = pts.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(metricOf(r)).toFixed(1)}" r="4" fill="${TAG_COLOR[r.tag] || "#e86a92"}"><title>${fmtDate(r.date)}: ${Math.round(metricOf(r))}</title></circle>`).join("");
  els.chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${grid}<path d="${line}" fill="none" stroke="#e86a92" stroke-width="2"/>${dots}</svg>`;
}

// ===== 起動 =====
reflectKey();
refreshRecordUI();
switchMode("camera");
initLandmarker();
