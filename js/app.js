'use strict';

/* =========================================================================
 * ウォーキング計測 PWA
 * - GPS(watchPosition)でリアルタイムに歩行経路を記録
 * - Haversine法で距離、速度ベースのMETs法で消費カロリーを推定
 * - データは端末内(localStorage)のみに保存。外部送信なし
 * ========================================================================= */

/* ---------- 定数 ---------- */
const STORE = {
  profile: 'walkcal.profile',
  walks: 'walkcal.walks',
  security: 'walkcal.security',
};

// GPSノイズ対策のしきい値
const ACCURACY_MAX_M = 35;   // 精度がこれより悪い測位は距離計算に使わない
const MIN_MOVE_M = 3;        // これ未満の移動はGPSのゆらぎとみなし無視
const MAX_SPEED_MS = 12;     // 12m/s(約43km/h)超はGPSの飛びとみなしリセット

/* ---------- 状態 ---------- */
const session = {
  status: 'idle',     // 'idle' | 'tracking' | 'paused'
  watchId: null,
  path: [],           // 採用した測位点 {lat,lng,t}
  distanceM: 0,
  calories: 0,
  movingMs: 0,        // 計測中の累積時間(一時停止を除く)
  lastResumeTs: null,
  lastPoint: null,    // 距離計算の基準点
  currentSpeedKmh: 0,
};

let map, locationMarker, accuracyCircle, routeLine;
let following = true;     // 地図が現在地を追従するか
let tickTimer = null;     // 時間表示更新
let wakeLock = null;      // 画面スリープ防止

/* =========================================================================
 * ストレージ
 * ========================================================================= */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch (e) { toast('保存できませんでした(空き容量不足の可能性)'); }
}

function getProfile() { return load(STORE.profile, { weightKg: null }); }
function getWalks() { return load(STORE.walks, []); }
function getSecurity() { return load(STORE.security, { enabled: false }); }

/* =========================================================================
 * 計算ユーティリティ
 * ========================================================================= */
function haversine(a, b) {
  const R = 6371000; // m
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 歩行速度(km/h)に応じたMETs値(運動強度) ※Compendium of Physical Activitiesを参考に簡略化
function metsForSpeed(kmh) {
  if (kmh < 3.2) return 2.0;   // ゆっくり
  if (kmh < 4.0) return 2.8;
  if (kmh < 4.8) return 3.0;   // 普通
  if (kmh < 5.6) return 3.5;
  if (kmh < 6.4) return 4.3;   // 速歩
  if (kmh < 7.2) return 5.0;
  return 7.0;                  // 早歩き〜ジョグ
}

// 消費カロリー(kcal) = METs × 体重(kg) × 時間(h)
function segmentCalories(distanceM, dtSec, weightKg) {
  const kmh = (distanceM / dtSec) * 3.6;
  const hours = dtSec / 3600;
  return metsForSpeed(kmh) * weightKg * hours;
}

/* =========================================================================
 * 表示フォーマット
 * ========================================================================= */
function fmtDistanceKm(m) { return (m / 1000).toFixed(2); }
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function fmtPace(distanceM, ms) {
  if (distanceM < 10) return "--'--";
  const minPerKm = (ms / 60000) / (distanceM / 1000);
  if (!isFinite(minPerKm) || minPerKm > 99) return "--'--";
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}'${String(s).padStart(2, '0')}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}(${days[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* =========================================================================
 * 地図
 * ========================================================================= */
function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView([35.681236, 139.767125], 16); // 初期: 東京駅

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  routeLine = L.polyline([], { color: '#ff3b30', weight: 5, opacity: 0.9 }).addTo(map);

  // ユーザーが地図を動かしたら追従を解除
  map.on('dragstart', () => { following = false; });
}

function updateLocationMarker(lat, lng, accuracy) {
  const latlng = [lat, lng];
  if (!locationMarker) {
    locationMarker = L.circleMarker(latlng, {
      radius: 8, color: '#fff', weight: 2, fillColor: '#ff3b30', fillOpacity: 1,
    }).addTo(map);
    accuracyCircle = L.circle(latlng, {
      radius: accuracy, color: '#ff3b30', weight: 1, fillColor: '#ff3b30', fillOpacity: 0.12,
    }).addTo(map);
  } else {
    locationMarker.setLatLng(latlng);
    accuracyCircle.setLatLng(latlng).setRadius(accuracy);
  }
  if (following) map.panTo(latlng, { animate: true, duration: 0.5 });
}

/* =========================================================================
 * GPS計測
 * ========================================================================= */
function setGpsBadge(state) {
  const el = $('#gps-badge');
  el.classList.remove('gps-off', 'gps-on', 'gps-wait');
  el.classList.add(state === 'on' ? 'gps-on' : state === 'wait' ? 'gps-wait' : 'gps-off');
  el.textContent = state === 'on' ? 'GPS ●' : state === 'wait' ? 'GPS …' : 'GPS';
}

function setGpsStatus(text, kind) {
  const el = $('#gps-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'error');
  if (kind) el.classList.add(kind);
}

function geoErrorMessage(err) {
  switch (err && err.code) {
    case 1: return '位置情報が許可されていません。iPhoneの「設定→プライバシーとセキュリティ→位置情報サービス」をオンにし、Safari/このAppを「使用中のみ許可」＋「正確な位置情報オン」にしてください。';
    case 2: return '現在地を取得できません。屋外や窓際で再度お試しください。';
    case 3: return 'GPSの取得がタイムアウトしました。空の見える場所で再試行してください。';
    default: return '位置情報の取得に失敗しました。';
  }
}

// 単発で現在地を取得して地図に表示(計測前の確認用 / ◎ボタン)
function locateOnce() {
  if (!('geolocation' in navigator)) {
    setGpsStatus('この端末は位置情報に対応していません', 'error');
    return;
  }
  setGpsBadge('wait');
  setGpsStatus('現在地を取得中…', null);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      following = true;
      setGpsBadge('on');
      updateLocationMarker(latitude, longitude, accuracy);
      map.setView([latitude, longitude], 17);
      setGpsStatus(`現在地を取得しました（精度 ±${Math.round(accuracy)}m）`, 'ok');
    },
    (err) => {
      setGpsBadge('off');
      setGpsStatus(geoErrorMessage(err), 'error');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function startTracking() {
  const profile = getProfile();
  if (!profile.weightKg) {
    toast('先に「設定」で体重を入力してください');
    switchView('settings');
    return;
  }
  if (!('geolocation' in navigator)) {
    toast('この端末では位置情報が使えません');
    return;
  }

  // 状態リセット
  Object.assign(session, {
    status: 'tracking', path: [], distanceM: 0, calories: 0,
    movingMs: 0, lastResumeTs: Date.now(), lastPoint: null, currentSpeedKmh: 0,
  });
  routeLine.setLatLngs([]);
  following = true;
  setGpsBadge('wait');
  setGpsStatus('GPS信号を待っています…（屋外だと早く取得できます）', null);

  // まず単発取得でプロンプト表示と初期位置の確定を行う
  navigator.geolocation.getCurrentPosition(
    (pos) => onPosition(pos),
    (err) => onPositionError(err),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );

  session.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
  });

  startTick();
  requestWakeLock();
  renderControls();
  renderStats();
}

function pauseTracking() {
  if (session.status !== 'tracking') return;
  session.movingMs += Date.now() - session.lastResumeTs;
  session.lastResumeTs = null;
  session.status = 'paused';
  session.lastPoint = null; // 再開時に空白区間を線で結ばない
  stopTick();
  renderControls();
  renderStats();
}

function resumeTracking() {
  if (session.status !== 'paused') return;
  session.lastResumeTs = Date.now();
  session.status = 'tracking';
  startTick();
  renderControls();
}

function stopTracking() {
  if (session.status === 'idle') return;
  if (session.status === 'tracking' && session.lastResumeTs) {
    session.movingMs += Date.now() - session.lastResumeTs;
  }
  if (session.watchId != null) {
    navigator.geolocation.clearWatch(session.watchId);
    session.watchId = null;
  }
  stopTick();
  releaseWakeLock();
  setGpsBadge('off');

  const distanceM = session.distanceM;
  const durationMs = session.movingMs;
  const calories = session.calories;

  // 10m以上歩いた場合のみ保存
  if (distanceM >= 10) {
    const walk = {
      id: Date.now(),
      startTime: session.path.length ? session.path[0].t : Date.now() - durationMs,
      endTime: Date.now(),
      distanceM, durationMs, calories,
      path: session.path.map((p) => ({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) })),
    };
    const walks = getWalks();
    walks.unshift(walk);
    save(STORE.walks, walks);
    showSummary(walk);
    renderHistory();
  } else {
    toast('記録するには10m以上の移動が必要です');
  }

  session.status = 'idle';
  renderControls();
  renderStats();
}

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const t = pos.timestamp;
  setGpsBadge('on');
  updateLocationMarker(latitude, longitude, accuracy);

  if (session.status !== 'tracking') {
    setGpsStatus(`現在地を取得しました（精度 ±${Math.round(accuracy)}m）`, 'ok');
    return;
  }
  if (accuracy > ACCURACY_MAX_M) {
    setGpsStatus(`GPS精度が低いため待機中（±${Math.round(accuracy)}m）`, null);
    return; // 精度が悪い点は採用しない
  }
  setGpsStatus(`GPS良好（±${Math.round(accuracy)}m）`, 'ok');

  const point = { lat: latitude, lng: longitude, t };

  if (!session.lastPoint) {
    session.lastPoint = point;
    session.path.push(point);
    routeLine.addLatLng([latitude, longitude]);
    return;
  }

  const d = haversine(session.lastPoint, point);
  const dt = (t - session.lastPoint.t) / 1000;
  if (dt <= 0) return;

  const speedMs = d / dt;
  if (speedMs > MAX_SPEED_MS) { session.lastPoint = point; return; } // GPSの飛び→基準だけ更新
  if (d < MIN_MOVE_M) return; // ゆらぎ→無視(基準は維持して微小移動を蓄積)

  session.distanceM += d;
  session.calories += segmentCalories(d, dt, getProfile().weightKg);
  session.currentSpeedKmh = speedMs * 3.6;
  session.path.push(point);
  routeLine.addLatLng([latitude, longitude]);
  session.lastPoint = point;
  renderStats();
}

function onPositionError(err) {
  // タイムアウト(3)は計測中なら一時的な可能性があるのでバッジのみ更新
  if (err && err.code === 3 && session.status === 'tracking') {
    setGpsBadge('wait');
    setGpsStatus('GPS信号が弱いです。空の見える場所へ移動してください…', null);
    return;
  }
  setGpsBadge('off');
  setGpsStatus(geoErrorMessage(err), 'error');
  toast(geoErrorMessage(err));
}

/* ---------- 時間表示 ---------- */
function currentDurationMs() {
  let ms = session.movingMs;
  if (session.status === 'tracking' && session.lastResumeTs) {
    ms += Date.now() - session.lastResumeTs;
  }
  return ms;
}
function startTick() {
  stopTick();
  tickTimer = setInterval(() => renderStats(), 1000);
}
function stopTick() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

/* ---------- Wake Lock(画面スリープ防止) ---------- */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* 非対応は無視 */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session.status === 'tracking' && !wakeLock) {
    requestWakeLock();
  }
});

/* =========================================================================
 * 描画
 * ========================================================================= */
function renderStats() {
  const durationMs = currentDurationMs();
  $('#stat-distance').textContent = fmtDistanceKm(session.distanceM);
  $('#stat-time').textContent = fmtDuration(durationMs);
  $('#stat-calories').textContent = Math.round(session.calories);
  // 平均速度を表示(瞬間値はぶれやすいため)
  const avgKmh = durationMs > 0 ? (session.distanceM / 1000) / (durationMs / 3600000) : 0;
  $('#stat-speed').textContent = (isFinite(avgKmh) ? avgKmh : 0).toFixed(1);
  $('#stat-pace').textContent = fmtPace(session.distanceM, durationMs);
}

function renderControls() {
  const idle = session.status === 'idle';
  const paused = session.status === 'paused';
  $('#btn-start').classList.toggle('hidden', !idle);
  $('#controls-running').classList.toggle('hidden', idle);
  $('#btn-pause').classList.toggle('hidden', paused);
  $('#btn-resume').classList.toggle('hidden', !paused);
}

function renderHistory() {
  const walks = getWalks();
  const list = $('#history-list');
  const empty = $('#history-empty');
  list.innerHTML = '';

  if (!walks.length) {
    empty.classList.remove('hidden');
    $('#history-summary').textContent = '';
    return;
  }
  empty.classList.add('hidden');

  const totalKm = walks.reduce((s, w) => s + w.distanceM, 0) / 1000;
  const totalCal = walks.reduce((s, w) => s + w.calories, 0);
  $('#history-summary').innerHTML =
    `合計 ${walks.length}回<br>${totalKm.toFixed(1)} km / ${Math.round(totalCal)} kcal`;

  for (const w of walks) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-item-top">
        <span class="history-date">${fmtDate(w.startTime)}</span>
        <span class="history-dist">${fmtDistanceKm(w.distanceM)} <small>km</small></span>
      </div>
      <div class="history-stats">
        <span>⏱ <b>${fmtDuration(w.durationMs)}</b></span>
        <span>🔥 <b>${Math.round(w.calories)}</b> kcal</span>
        <span>👣 <b>${fmtPace(w.distanceM, w.durationMs)}</b>/km</span>
      </div>
      <div class="history-actions">
        <button class="btn btn-secondary" data-act="gpx" data-id="${w.id}">GPX書き出し</button>
        <button class="btn btn-danger-outline" data-act="del" data-id="${w.id}">削除</button>
      </div>`;
    list.appendChild(li);
  }
}

function showSummary(walk) {
  $('#summary-content').innerHTML = `
    <div class="summary-row"><span>距離</span><b>${fmtDistanceKm(walk.distanceM)} km</b></div>
    <div class="summary-row"><span>時間</span><b>${fmtDuration(walk.durationMs)}</b></div>
    <div class="summary-row"><span>消費カロリー</span><b>${Math.round(walk.calories)} kcal</b></div>
    <div class="summary-row"><span>平均ペース</span><b>${fmtPace(walk.distanceM, walk.durationMs)} /km</b></div>`;
  $('#summary-modal').classList.remove('hidden');
}

/* =========================================================================
 * 履歴の操作(削除 / GPX書き出し)
 * ========================================================================= */
function deleteWalk(id) {
  if (!confirm('この記録を削除しますか?')) return;
  save(STORE.walks, getWalks().filter((w) => w.id !== id));
  renderHistory();
  toast('削除しました');
}

function exportGpx(id) {
  const walk = getWalks().find((w) => w.id === id);
  if (!walk || !walk.path || !walk.path.length) { toast('経路データがありません'); return; }
  const pts = walk.path.map((p) => `<trkpt lat="${p.lat}" lon="${p.lng}"></trkpt>`).join('\n');
  const gpx =
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ウォーキング計測" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Walk ${fmtDate(walk.startTime)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`;
  downloadFile(gpx, `walk-${walk.id}.gpx`, 'application/gpx+xml');
}

function exportBackup() {
  const data = { profile: getProfile(), walks: getWalks(), exportedAt: new Date().toISOString() };
  downloadFile(JSON.stringify(data, null, 2), `walkcal-backup-${Date.now()}.json`, 'application/json');
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================================================
 * 設定: 体重 / データ削除
 * ========================================================================= */
function saveWeight() {
  const v = parseFloat($('#input-weight').value);
  if (!v || v < 20 || v > 250) { toast('20〜250kgの範囲で入力してください'); return; }
  const profile = getProfile();
  profile.weightKg = v;
  save(STORE.profile, profile);
  toast('体重を保存しました');
}

function clearAllData() {
  if (!confirm('体重・履歴・PINを含むすべてのデータを削除します。よろしいですか?')) return;
  localStorage.removeItem(STORE.profile);
  localStorage.removeItem(STORE.walks);
  localStorage.removeItem(STORE.security);
  $('#input-weight').value = '';
  $('#toggle-pin').checked = false;
  $('#pin-setup').classList.add('hidden');
  renderHistory();
  toast('すべてのデータを削除しました');
}

/* =========================================================================
 * セキュリティ: PINロック (Web Crypto / PBKDF2)
 * ========================================================================= */
function bufToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function b64ToBuf(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

async function hashPin(pin, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64 ? b64ToBuf(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: bufToB64(bits), salt: bufToB64(salt) };
}

async function setupPin() {
  const pin = $('#pin-new').value.trim();
  const confirmPin = $('#pin-confirm').value.trim();
  const msg = $('#pin-msg');
  if (!/^\d{4,8}$/.test(pin)) { msg.textContent = 'PINは4〜8桁の数字で入力してください'; return; }
  if (pin !== confirmPin) { msg.textContent = 'PINが一致しません'; return; }
  const { hash, salt } = await hashPin(pin);
  save(STORE.security, { enabled: true, hash, salt });
  $('#pin-new').value = ''; $('#pin-confirm').value = '';
  $('#pin-setup').classList.add('hidden');
  msg.textContent = '';
  toast('PINロックを有効にしました');
}

function disablePin() {
  save(STORE.security, { enabled: false });
  toast('PINロックを解除しました');
}

async function tryUnlock() {
  const sec = getSecurity();
  const pin = $('#lock-input').value.trim();
  const { hash } = await hashPin(pin, sec.salt);
  if (hash === sec.hash) {
    $('#lock-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#lock-input').value = '';
    $('#lock-error').textContent = '';
    invalidateMapSize();
  } else {
    $('#lock-error').textContent = 'PINが違います';
    $('#lock-input').value = '';
  }
}

function maybeShowLock() {
  const sec = getSecurity();
  if (sec.enabled && sec.hash) {
    $('#lock-screen').classList.remove('hidden');
    $('#app').classList.add('hidden');
    setTimeout(() => $('#lock-input').focus(), 100);
    return true;
  }
  $('#app').classList.remove('hidden');
  return false;
}

/* =========================================================================
 * ナビゲーション
 * ========================================================================= */
function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('tab-active', t.dataset.view === name));
  const titles = { track: 'ウォーキング計測', history: '履歴', settings: '設定' };
  $('#header-title').textContent = titles[name] || '';
  if (name === 'track') invalidateMapSize();
  if (name === 'history') renderHistory();
}

function invalidateMapSize() {
  if (map) setTimeout(() => map.invalidateSize(), 150);
}

/* =========================================================================
 * 小物
 * ========================================================================= */
function $(sel) { return document.querySelector(sel); }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

/* =========================================================================
 * 初期化
 * ========================================================================= */
function bindEvents() {
  // タブ
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)));

  // 計測コントロール
  $('#btn-start').addEventListener('click', startTracking);
  $('#btn-pause').addEventListener('click', pauseTracking);
  $('#btn-resume').addEventListener('click', resumeTracking);
  $('#btn-stop').addEventListener('click', stopTracking);
  $('#recenter').addEventListener('click', () => {
    following = true;
    if (session.status === 'tracking' && locationMarker) {
      map.panTo(locationMarker.getLatLng());
    } else {
      locateOnce(); // 計測前は現在地を取得して表示
    }
  });

  // 設定
  $('#btn-save-weight').addEventListener('click', saveWeight);
  $('#input-weight').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveWeight(); });
  $('#btn-export').addEventListener('click', exportBackup);
  $('#btn-clear').addEventListener('click', clearAllData);

  // PIN
  $('#toggle-pin').addEventListener('change', (e) => {
    if (e.target.checked) {
      $('#pin-setup').classList.remove('hidden');
    } else {
      $('#pin-setup').classList.add('hidden');
      disablePin();
    }
  });
  $('#btn-save-pin').addEventListener('click', setupPin);
  $('#lock-unlock').addEventListener('click', tryUnlock);
  $('#lock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

  // 履歴(イベント委譲)
  $('#history-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'del') deleteWalk(id);
    if (btn.dataset.act === 'gpx') exportGpx(id);
  });

  // サマリー
  $('#summary-close').addEventListener('click', () => $('#summary-modal').classList.add('hidden'));

  // 計測中に離脱しようとしたら警告
  window.addEventListener('beforeunload', (e) => {
    if (session.status !== 'idle') { e.preventDefault(); e.returnValue = ''; }
  });
}

function loadSettingsIntoUI() {
  const profile = getProfile();
  if (profile.weightKg) $('#input-weight').value = profile.weightKg;
  const sec = getSecurity();
  $('#toggle-pin').checked = !!sec.enabled;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  }
}

function init() {
  bindEvents();
  loadSettingsIntoUI();
  initMap();
  renderControls();
  renderStats();
  renderHistory();
  maybeShowLock();
  invalidateMapSize();
  registerServiceWorker();

  // 起動時に一度だけ現在地取得を試みる(権限プロンプトの表示と初期表示)
  if (!getSecurity().enabled) setTimeout(locateOnce, 600);
}

document.addEventListener('DOMContentLoaded', init);
