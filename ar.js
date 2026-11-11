// 어나더레드 웹 플레이어: 게임 데이터 다운로드(OPFS), 터치 패드, 세이브 백업/복원.
// 엔진은 assets/player.js (mkxp-z libretro + Nostalgist, build_site.py 가 패치)

// 앱에서는 다른 RPG Maker 게임도 연다: ?game=<OPFS 파일 이름>&src=<Games 폴더의 원본 파일>
const params = new URLSearchParams(location.search);
const BUILTIN = 'AnotherRed.mkxpz';
const GAME_FILE = params.get('game') || BUILTIN;
const CUSTOM = GAME_FILE !== BUILTIN;
const SRC = params.get('src');
window.__arFile = GAME_FILE;
window.__arTitle = CUSTOM ? GAME_FILE.replace(/\.mkxpz$/, '') : '포켓몬스터 어나더 레드';
const DONE_KEY = 'ar-game-hash';
const $ = (id) => document.getElementById(id);

// ---------- OPFS 쓰기 (사파리는 메인 스레드 createWritable 이 불안정해서 워커의 sync handle 사용) ----------
const workerSrc = `
let ah;
async function handleFor(path, create) {
  let dir = await navigator.storage.getDirectory();
  const parts = path.split('/').filter(Boolean);
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'open') {
      ah = await (await handleFor(m.path, true)).createSyncAccessHandle();
      if (m.truncate !== undefined) ah.truncate(m.truncate);
      postMessage({ ok: true, size: ah.getSize() });
    } else if (m.cmd === 'write') {
      let at = m.at, buf = new Uint8Array(m.buf);
      while (buf.length) { const n = ah.write(buf, { at }); at += n; buf = buf.subarray(n); }
      postMessage({ ok: true });
    } else if (m.cmd === 'close') {
      ah.flush(); ah.close(); ah = null;
      postMessage({ ok: true });
    } else if (m.cmd === 'put') {
      const h = await (await handleFor(m.path, true)).createSyncAccessHandle();
      h.truncate(0); h.write(new Uint8Array(m.buf), { at: 0 }); h.flush(); h.close();
      postMessage({ ok: true });
    }
  } catch (err) { postMessage({ ok: false, error: String(err) }); }
};`;
let worker;
let queue = Promise.resolve();
function opfs(msg, transfer = []) {
  worker ??= new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
  const run = () => new Promise((resolve, reject) => {
    worker.onmessage = (e) => (e.data.ok ? resolve(e.data) : reject(new Error(e.data.error)));
    worker.postMessage(msg, transfer);
  });
  return (queue = queue.then(run, run));
}

async function root() { return navigator.storage.getDirectory(); }
async function gameFileSize() {
  try { return (await (await (await root()).getFileHandle(GAME_FILE)).getFile()).size; } catch { return 0; }
}
const mb = (n) => (n / 1048576).toFixed(0) + 'MB';

// ---------- 상태 / 다운로드 ----------
let manifest;
let nost = null;

function setStatus(text) { $('status').textContent = text; }
function setProgress(frac) {
  $('progress').hidden = frac === null;
  if (frac !== null) $('bar').style.width = (frac * 100).toFixed(1) + '%';
}

async function refresh() {
  if (!window.isSecureContext) return setStatus('HTTPS 주소에서 열어야 해요.');
  if (!window.crossOriginIsolated) {
    // 서비스 워커가 설정을 받은 뒤라야 격리가 켜진다 → 몇 번까지 자동으로 다시 연다
    const tries = Number(sessionStorage.getItem('ar-coi-tries') || 0);
    if (navigator.serviceWorker?.controller && tries < 3) {
      sessionStorage.setItem('ar-coi-tries', String(tries + 1));
      setTimeout(() => location.reload(), 300);
    }
    return setStatus('준비 중… 잠시 후에도 그대로면 앱을 완전히 닫았다가 다시 열어주세요.');
  }
  sessionStorage.removeItem('ar-coi-tries');
  await appSaves();
  if (CUSTOM) return refreshCustom();
  manifest = await (await fetch('./game/manifest.json', { cache: 'no-store' })).json();
  const size = await gameFileSize();
  const ready = localStorage.getItem(DONE_KEY) === manifest.hash && size === manifest.size;
  $('start').hidden = !ready || !!nost;
  $('resume').hidden = !nost;
  $('download').hidden = ready;
  if (ready) {
    setStatus(nost ? '일시정지됨' : '게임 데이터 준비 완료 (' + mb(manifest.size) + ')');
  } else if (size > 0 && localStorage.getItem(DONE_KEY + '-pending') === manifest.hash) {
    setStatus(`받다 만 데이터가 있어요 (${mb(size)} / ${mb(manifest.size)}). 이어받기를 누르세요.`);
    $('download').textContent = '이어받기';
  } else {
    setStatus(`처음 한 번 게임 데이터를 받아야 해요 (${mb(manifest.size)}). 와이파이 권장.`);
  }
  try {
    const est = await navigator.storage.estimate();
    if (est.quota && est.quota - est.usage < manifest.size - size)
      $('hint').textContent = `저장공간이 부족할 수 있어요 (남은 할당량 ${mb(est.quota - est.usage)}).`;
  } catch {}
}

// 가져온 게임: Games 폴더의 원본을 엔진이 읽을 수 있는 저장공간으로 한 번 옮긴다
async function refreshCustom() {
  document.querySelector('#menu h1').textContent = window.__arTitle;
  document.querySelector('#menu .sub').textContent = 'RPG Maker 게임';
  $('download').hidden = true;
  const list = SRC ? await (await fetch('/games/', { cache: 'no-store' })).json() : [];
  const src = list.find((f) => f.name === SRC);
  if (src && !nost) {
    $('start').hidden = true;
    try {
      const PART = 20 * 1048576;
      await opfs({ cmd: 'open', path: GAME_FILE, truncate: 0 });
      try {
        for (let at = 0; at < src.size; at += PART) {
          setStatus(`게임 준비 중… ${mb(at)} / ${mb(src.size)}`);
          setProgress(at / src.size);
          const res = await fetch('/games/' + encodeURIComponent(SRC), { headers: { Range: `bytes=${at}-${Math.min(at + PART, src.size) - 1}` } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const buf = await res.arrayBuffer();
          await opfs({ cmd: 'write', at, buf }, [buf]);
        }
      } finally {
        await opfs({ cmd: 'close' });
      }
      if ((await gameFileSize()) !== src.size) throw new Error('파일 크기가 맞지 않아요');
      // 같은 파일이 두 벌 남지 않게 원본은 지운다
      await fetch('/games/' + encodeURIComponent(SRC), { method: 'DELETE' });
    } catch (err) {
      setProgress(null);
      return setStatus('게임 준비 실패: ' + err.message);
    }
    setProgress(null);
  }
  const size = await gameFileSize();
  $('start').hidden = !size || !!nost;
  $('resume').hidden = !nost;
  setStatus(nost ? '일시정지됨' : size ? `준비 완료 (${mb(size)})` : '게임 파일을 찾을 수 없어요. 목록에서 다시 추가해 주세요.');
}

async function download() {
  $('download').disabled = true;
  try {
    await navigator.storage.persist?.();
    const PART = 20 * 1048576; // build_game.sh 의 split -b 20m
    let have = await gameFileSize();
    if (localStorage.getItem(DONE_KEY + '-pending') !== manifest.hash) have = 0;
    localStorage.removeItem(DONE_KEY);
    localStorage.setItem(DONE_KEY + '-pending', manifest.hash);
    const first = Math.floor(have / PART);
    await opfs({ cmd: 'open', path: GAME_FILE, truncate: first * PART });
    try {
      for (let i = first; i < manifest.parts.length; i++) {
        setStatus(`게임 데이터 받는 중… ${i + 1} / ${manifest.parts.length}`);
        setProgress(i / manifest.parts.length);
        let buf;
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await fetch((manifest.base ?? './game/') + manifest.parts[i], { cache: 'no-store' }); // 브라우저 캐시에 500MB 가 또 쌓이지 않게
            if (!res.ok) throw new Error('HTTP ' + res.status);
            buf = await res.arrayBuffer();
            break;
          } catch (err) {
            if (attempt >= 4) throw err;
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        await opfs({ cmd: 'write', at: i * PART, buf }, [buf]);
      }
    } finally {
      await opfs({ cmd: 'close' });
    }
    if ((await gameFileSize()) !== manifest.size) throw new Error('파일 크기가 맞지 않아요');
    localStorage.setItem(DONE_KEY, manifest.hash);
    localStorage.removeItem(DONE_KEY + '-pending');
    setProgress(null);
  } catch (err) {
    setProgress(null);
    $('hint').textContent = '다운로드 실패: ' + err.message + ' — 다시 누르면 이어받아요.';
  }
  $('download').disabled = false;
  await refresh();
}

// ---------- 일시정지 ----------
// 엔진의 일시정지(PAUSE_TOGGLE)는 이 코어에서 다시 풀 때 게임이 멈춰버린다.
// 대신 엔진이 매 프레임 부르는 requestAnimationFrame 을 붙잡아 둔다 (홈으로 나갔을 때 iOS 가 하는 것과 같은 방식).
const rafOrig = window.requestAnimationFrame.bind(window);
let frozen = false;
const heldFrames = [];
window.requestAnimationFrame = (f) => (frozen ? (heldFrames.push(f), 0) : rafOrig(f));
function hold(on) {
  frozen = on;
  if (!on) for (const f of heldFrames.splice(0)) rafOrig(f);
}

// ---------- 로딩 로그: 검은 화면일 때 무슨 일이 일어나는지 보이게 ----------
const logLines = [];
let logOn = false;
const DEBUG = new URLSearchParams(location.search).has('debug') || !!sessionStorage.getItem('ar-debug');
function addLog(text) {
  if (DEBUG) try { navigator.sendBeacon('/log', (performance.now() / 1000).toFixed(1) + 's ' + String(text).slice(0, 300)); } catch {}
  // 게임이 화면 크기를 정하면 첫 화면이 나온 것
  if (String(text).includes('SET_GEOMETRY')) onGameShown();
  if (!logOn || !DEBUG) return;
  text = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  if (/GLSL|Playlist|Environ\] (GET|SET)_|\[GL\]|Linking|shader/i.test(text)) return;
  logLines.push(text.slice(0, 160));
  if (logLines.length > 8) logLines.shift();
  $('log').textContent = logLines.join('\n');
}
for (const k of ['log', 'info', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { orig(...a); addLog(a.join(' ')); };
}
window.addEventListener('error', (e) => addLog('오류: ' + e.message));
if (DEBUG) {
  // 진단용: 초당 프레임 수와 WebGL 컨텍스트 손실 보고
  let frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (f) => raf((t) => { frames++; f(t); });
  setInterval(() => {
    const c = document.querySelector('#screen canvas');
    navigator.sendBeacon('/log', `[dbg] audio=${audioCtxs.map((c) => c.state).join(',')} nost=${!!nost}/${!!window.__arNost} raf/2s=${frames} canvas=${c?.width}x${c?.height} css=${c?.clientWidth}x${c?.clientHeight} vis=${document.visibilityState}`);
    frames = 0;
  }, 2000);
  document.addEventListener('webglcontextlost', () => navigator.sendBeacon('/log', '[dbg] webglcontextlost'), true);
}
window.addEventListener('unhandledrejection', (e) => addLog('오류: ' + (e.reason?.message ?? e.reason)));
function hideLog() { logOn = false; $('log').hidden = true; clearInterval(loadingTimer); }
let loadingTimer;
function showLoading() {
  logOn = true;
  $('log').hidden = false;
  const t0 = Date.now();
  const tick = () => {
    if (DEBUG) return;
    const sec = Math.round((Date.now() - t0) / 1000);
    $('log').textContent = `게임 불러오는 중… ${sec}초\n처음 켤 때는 1~3분쯤 걸려요. 화면이 검어도 기다려 주세요.`;
  };
  tick();
  loadingTimer = setInterval(tick, 1000);
}
function onGameShown() {
  if (!logOn) return;
  hideLog();
}


// ---------- 오디오: iOS 는 터치 안에서 만들어지지 않은 AudioContext 를 멈춰두고,
// 엔진은 오디오가 안 돌면 게임 진행까지 멈춘다 → 만들어진 컨텍스트를 모아두고 터치 때마다 깨운다
// 그래서 '게임 시작' 터치 안에서 미리 깨워둔 컨텍스트를 엔진이 처음 만들 때 대신 넘겨준다
const audioCtxs = [];
const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
let primedAudio = null;
// 백그라운드에서는 엔진이 resume 을 불러도 소리가 다시 나지 않게 막고,
// 엔진 출력은 음소거용 볼륨 노드를 거쳐서 나가게 한다
function guardAudio(ctx) {
  const resume = ctx.resume.bind(ctx);
  ctx.resume = () => (document.hidden || asleep ? Promise.resolve() : resume());
  const out = ctx.createGain();
  out.connect(ctx.destination);
  Object.defineProperty(ctx, 'destination', { get: () => out });
  ctx.arOut = out;
  audioCtxs.push(ctx);
  return ctx;
}
function muteAudio(on) {
  for (const c of audioCtxs) c.arOut.gain.value = on ? 0 : 1;
}
if (OrigAudioContext) {
  window.AudioContext = window.webkitAudioContext = class extends OrigAudioContext {
    constructor(...a) {
      if (primedAudio) {
        const ctx = primedAudio;
        primedAudio = null;
        return ctx;
      }
      super(...a);
      guardAudio(this);
    }
  };
}
function primeAudio() {
  if (!OrigAudioContext || primedAudio) return;
  try {
    primedAudio = guardAudio(new OrigAudioContext({ latencyHint: 'interactive' }));
    primedAudio.resume().catch(() => {});
  } catch {}
}
function wakeAudio() {
  if (document.hidden) return;
  for (const c of audioCtxs) if (c.state !== 'running' && c.state !== 'closed') c.resume().catch(() => {});
}
for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, wakeAudio, true);

// ---------- 게임 시작 ----------
window.__arGame = async () => (await (await root()).getFileHandle(GAME_FILE)).getFile();
window.__arStarted = (z) => {
  nost = z;
  $('pad').hidden = false;
};

async function start() {
  primeAudio(); // 반드시 await 전에, 터치 처리 안에서
  addLog('[ar] start tapped');
  $('start').disabled = true;
  await navigator.storage.persist?.();
  // 무음 스위치가 켜져 있어도 소리가 나도록
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  // 번들이 처음 한 번 강제로 새로고침하는 단계를 건너뛴다 (coi 는 이미 확인됨)
  sessionStorage.setItem('nostalgist status for mkxp-z @ ' + location.href, 'ready');
  await installPreload().catch((err) => addLog('[ar] preload: ' + err.message));
  $('menu').hidden = true;
  $('pad').hidden = false;
  showLoading();
  try {
    await import('./assets/player.js?v=20261111132921');
    addLog('[ar] 엔진 시작 완료');
  } catch (err) {
    addLog('[ar] 엔진 시작 실패: ' + (err?.message ?? err));
  }
}

// ---------- 이름 입력 (한글) ----------
// 게임은 키보드 글자를 못 받는다. 게임 쪽 스크립트(ar_preload.rb)가 세이브 폴더에 요청 파일을 쓰면
// 여기서 입력창을 띄우고 답을 파일로 돌려준다.
const SAVES = ['saves', 'mkxp-z', 'mkxp-z', 'mkxp-z', 'Saves'];
async function saveDirs(create) {
  let dir = await root();
  for (const p of SAVES) dir = await dir.getDirectoryHandle(p, { create });
  const out = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'directory') out.push([name, h]);
  return out;
}
// 게임 파일 안의 예전 스크립트보다 세이브 폴더의 것이 먼저 읽힌다 → 게임 데이터를 다시 받지 않고 바꿀 수 있다
async function installPreload() {
  const res = await fetch('./ar_preload.rb?v=20261111132921');
  if (!res.ok) return;
  const script = await res.arrayBuffer();
  const names = (await saveDirs(true)).map(([name]) => name);
  if (!CUSTOM && !names.length) names.push('Pokmon; Another Red-sxa4980p'); // 처음 켤 때는 폴더가 아직 없다
  for (const name of names) await opfs({ cmd: 'put', path: [...SAVES, name, 'ar_preload.rb'].join('/'), buf: script.slice(0) });
}
const asked = new Set();
let asking = false;
async function pollNameInput() {
  if (!nost || asking || asleep) return;
  asking = true;
  try {
    for (const [dirName, dir] of await saveDirs(false)) {
      for await (const [name, h] of dir.entries()) {
        if (!/^ar_in_\d+\.req$/.test(name) || asked.has(name)) continue;
        asked.add(name);
        const [max, help, initial = ''] = (await (await h.getFile()).text()).split('\n');
        const path = [...SAVES, dirName, name.slice(0, -4)].join('/');
        const put = (ext, text) => { const buf = new TextEncoder().encode(text).buffer; return opfs({ cmd: 'put', path: path + ext, buf }, [buf]); };
        await put('.ack', '1');
        releaseAll();
        const answer = prompt(`${help} (최대 ${max}자)`, initial);
        await put('.res', answer === null ? 'CANCEL' : 'OK\n' + answer);
      }
    }
  } catch {} finally { asking = false; }
}
setInterval(pollNameInput, 400);

function openMenu() {
  if (!nost) return;
  hold(true);
  muteAudio(true);
  releaseAll();
  $('menu').hidden = false;
  refresh();
}
function closeMenu() {
  $('menu').hidden = true;
  hold(false);
  if (!unseen && !asleep) muteAudio(false);
}

// ---------- 터치 패드 ----------
const held = new Map(); // pointerId -> button
// 아주 짧은 탭은 게임이 한 프레임 처리하기 전에 끝나버려서 못 읽는다 → 최소 150ms 는 누른 상태로 둔다
const downAt = new Map();
function press(btn, down) {
  if (!nost) return;
  const canvas = nost.getCanvas?.();
  if (canvas && document.activeElement !== canvas) canvas.focus?.();
  if (down) {
    downAt.set(btn, performance.now());
  } else {
    const wait = 150 - (performance.now() - (downAt.get(btn) ?? 0));
    if (wait > 0) return setTimeout(() => press(btn, false), wait);
  }
  try { (down ? nost.pressDown : nost.pressUp).call(nost, { button: btn }); } catch {}
}
function releaseAll() {
  for (const btn of new Set(held.values())) press(btn, false);
  held.clear();
  document.querySelectorAll('#pad .on').forEach((el) => el.classList.remove('on'));
}

for (const el of document.querySelectorAll('#pad [data-btn]')) {
  const btn = el.dataset.btn;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    held.set(e.pointerId, btn);
    el.classList.add('on');
    press(btn, true);
  });
  const up = (e) => {
    if (!held.has(e.pointerId)) return;
    held.delete(e.pointerId);
    el.classList.remove('on');
    press(btn, false);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

// 십자키: 손가락을 떼지 않고 미끄러지면 방향이 바뀐다
const dpad = $('dpad');
let dpadPointer = null, dpadDir = null;
function setDir(dir) {
  if (dir === dpadDir) return;
  if (dpadDir) { press(dpadDir, false); dpad.querySelector('.' + dpadDir).classList.remove('on'); }
  dpadDir = dir;
  if (dir) { press(dir, true); dpad.querySelector('.' + dir).classList.add('on'); }
}
function dirFrom(e) {
  const r = dpad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  if (Math.hypot(dx, dy) < r.width * 0.12) return dpadDir; // 가운데 데드존
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}
dpad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dpad.setPointerCapture(e.pointerId);
  dpadPointer = e.pointerId;
  setDir(dirFrom(e));
});
dpad.addEventListener('pointermove', (e) => { if (e.pointerId === dpadPointer) setDir(dirFrom(e)); });
const dpadUp = (e) => { if (e.pointerId === dpadPointer) { dpadPointer = null; setDir(null); } };
dpad.addEventListener('pointerup', dpadUp);
dpad.addEventListener('pointercancel', dpadUp);

let ff = false;
$('ff').addEventListener('click', () => {
  if (!nost) return;
  ff = !ff;
  nost.sendCommand('FAST_FORWARD');
  $('ff').classList.toggle('on', ff);
});
$('open-menu').addEventListener('click', openMenu);
document.addEventListener('gesturestart', (e) => e.preventDefault());
// 홈으로 나가거나 화면이 꺼지면 게임과 소리를 멈추고, 돌아오면 다시 켠다
// ('playback' 오디오 세션은 그냥 두면 백그라운드에서도 계속 소리를 낸다)
let asleep = false;
// 앱의 게임 목록 화면 뒤에 숨어 있는 동안 (app.js 가 알려준다)
let frameHidden = false;
const FRAMED = window.parent !== window;
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.ar === 'hide') { frameHidden = true; sleepGame(); }
  if (e.data?.ar === 'show') { frameHidden = false; if (nost) $('menu').hidden = true; wakeGame(); } // 목록에서 다시 누르면 바로 게임으로
});
let unseen = false; // 화면이 안 그려지는 중 (아래 감시)
function sleepGame() {
  if (asleep) return;
  asleep = true;
  syncOut();
  addLog('[ar] sleep');
  releaseAll();
  muteAudio(true);
  hold(true);
  for (const c of audioCtxs) if (c.state === 'running') c.suspend().catch(() => {});
}
function wakeGame() {
  if (!asleep || document.hidden || frameHidden) return;
  asleep = false;
  addLog('[ar] wake');
  if ($('menu').hidden) {
    hold(false);
    if (!unseen) muteAudio(false);
  }
  wakeAudio();
}
document.addEventListener('visibilitychange', () => (document.hidden ? sleepGame() : wakeGame()));
window.addEventListener('pagehide', sleepGame);
window.addEventListener('pageshow', wakeGame);
// iOS 는 홈으로 나가도 visibilitychange 없이 화면 그리기만 멈추는 경우가 있다
// → 화면 프레임이 1초 넘게 안 오면 소리만 끈다 (로딩 중에 잠깐 멈출 때도 있어서 게임은 그대로 둔다)
let lastFrame = performance.now();
rafOrig(function frame() {
  lastFrame = performance.now();
  if (unseen) {
    unseen = false;
    addLog('[ar] seen');
    if (!asleep && !frozen) muteAudio(false);
  }
  rafOrig(frame);
});
setInterval(() => {
  if (unseen || performance.now() - lastFrame < 1000) return;
  unseen = true;
  addLog('[ar] unseen');
  muteAudio(true);
}, 300);

// ---------- 세이브 백업 / 복원 (zip, 무압축) ----------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let off = 0;
  for (const { name, data } of files) {
    const n = enc.encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, n.length, true);
    chunks.push(h, n, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, n.length, true); c.setUint32(42, off, true);
    central.push(c, n);
    off += 30 + n.length + data.length;
  }
  const size = central.reduce((s, x) => s + x.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...chunks, ...central, e], { type: 'application/zip' });
}
function readZip(buf) {
  const v = new DataView(buf), dec = new TextDecoder(), out = [];
  let p = 0;
  while (p + 30 <= buf.byteLength && v.getUint32(p, true) === 0x04034b50) {
    const method = v.getUint16(p + 8, true), size = v.getUint32(p + 18, true);
    const nlen = v.getUint16(p + 26, true), xlen = v.getUint16(p + 28, true);
    if (method !== 0) throw new Error('이 플레이어에서 만든 백업 파일만 복원할 수 있어요');
    const name = dec.decode(new Uint8Array(buf, p + 30, nlen));
    const start = p + 30 + nlen + xlen;
    if (!name.endsWith('/')) out.push({ name, data: buf.slice(start, start + size) });
    p = start + size;
  }
  return out;
}

// OPFS 루트에서 게임 파일을 뺀 전부(saves/, states/, system/)가 사용자 데이터
async function collect(dir, prefix, out) {
  for await (const [name, h] of dir.entries()) {
    const path = prefix + name;
    if ((!prefix && path.endsWith('.mkxpz')) || path.startsWith('.') || name.startsWith('ar_')) continue;
    if (h.kind === 'directory') await collect(h, path + '/', out);
    else out.push({ name: path, data: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
  }
  return out;
}

async function exportSaves() {
  try {
    const files = await collect(await root(), '', []);
    if (!files.length) return ($('hint').textContent = '아직 백업할 세이브가 없어요.');
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const name = `AnotherRed-save-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
    const file = new File([makeZip(files)], name, { type: 'application/zip' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    $('hint').textContent = `백업 완료: 파일 ${files.length}개 (${name})`;
  } catch (err) {
    if (err.name !== 'AbortError') $('hint').textContent = '백업 실패: ' + err.message;
  }
}

async function importSaves(file) {
  try {
    const files = readZip(await file.arrayBuffer()).filter((f) => !f.name.endsWith('.mkxpz'));
    if (!files.length) throw new Error('백업 파일에 세이브가 없어요');
    if (!confirm(`세이브 파일 ${files.length}개로 덮어쓸까요? 지금 기기의 같은 이름 세이브는 바뀌어요.`)) return;
    for (const f of files) await opfs({ cmd: 'put', path: f.name, buf: f.data }, [f.data]);
    if (nost) {
      alert('복원했어요. 적용하려면 페이지를 다시 엽니다.');
      location.reload();
    } else {
      $('hint').textContent = `복원 완료: 파일 ${files.length}개`;
    }
  } catch (err) {
    $('hint').textContent = '복원 실패: ' + err.message;
  }
}

// ---------- 앱 전용: 세이브를 파일 앱에서 보이는 폴더에 자동으로 복사 ----------
// 앱을 지웠다 다시 깔아도 그 폴더를 고르면 세이브가 돌아온다.
const APP = window.webkit?.messageHandlers?.ar ?? (FRAMED ? window.parent.webkit?.messageHandlers?.ar : undefined);
const synced = new Map(); // 경로 -> 크기:수정시각
const saveUrl = (name) => '/saves/' + name.split('/').map(encodeURIComponent).join('/');
async function listSaves(dir, prefix, out) {
  for await (const [name, h] of dir.entries()) {
    const path = prefix + name;
    if ((!prefix && path.endsWith('.mkxpz')) || path.startsWith('.') || name.startsWith('ar_')) continue;
    if (h.kind === 'directory') await listSaves(h, path + '/', out);
    else try { out.push({ name: path, file: await h.getFile() }); } catch {}
  }
  return out;
}
let syncing = false;
async function syncOut() {
  if (!APP || syncing) return;
  syncing = true;
  try {
    for (const { name, file } of await listSaves(await root(), '', [])) {
      const sig = file.size + ':' + file.lastModified;
      if (synced.get(name) === sig) continue;
      const r = await fetch(saveUrl(name), { method: 'PUT', body: await file.arrayBuffer() });
      if (r.ok) synced.set(name, sig);
    }
  } catch {} finally { syncing = false; }
}
async function folderSaves() { return (await fetch('/saves/', { cache: 'no-store' })).json(); }
async function syncIn(names) {
  for (const name of names) {
    const buf = await (await fetch(saveUrl(name), { cache: 'no-store' })).arrayBuffer();
    await opfs({ cmd: 'put', path: name, buf }, [buf]);
  }
}
function showFolder(info) {
  $('folder').hidden = $('folder-hint').hidden = false;
  $('folder-hint').textContent = `세이브 자동 저장 위치: ${info.label}` + (info.outside ? '' : ' (앱을 지우면 같이 지워져요. 폴더를 고르면 남아요.)');
}
let appReady = false;
async function appSaves() {
  if (!APP || appReady) return;
  appReady = true;
  try {
    showFolder(await APP.postMessage('folder'));
    // 새로 깐 앱이면 폴더에 남아 있던 세이브를 가져온다
    const names = await folderSaves();
    if (names.length && !(await listSaves(await root(), '', [])).length) {
      await syncIn(names);
      $('hint').textContent = `폴더에서 세이브 파일 ${names.length}개를 불러왔어요.`;
    }
    await syncOut();
    setInterval(syncOut, 5000);
  } catch (err) { addLog('[ar] 세이브 폴더 오류: ' + err.message); }
}
async function pickFolder() {
  try {
    const info = await APP.postMessage('pick');
    if (!info) return;
    showFolder(info);
    synced.clear();
    const names = await folderSaves();
    const mine = (await listSaves(await root(), '', [])).length;
    if (names.length && (!mine || confirm(`이 폴더에 세이브 파일 ${names.length}개가 있어요. 불러올까요?\n\n확인: 폴더의 세이브를 불러와요 (지금 세이브는 바뀌어요).\n취소: 지금 세이브를 이 폴더에 덮어 저장해요.`))) {
      await syncIn(names);
      if (nost) { alert('불러왔어요. 적용하려면 다시 엽니다.'); return location.reload(); }
      $('hint').textContent = `폴더에서 세이브 파일 ${names.length}개를 불러왔어요.`;
    }
    await syncOut();
  } catch (err) { $('hint').textContent = '폴더 설정 실패: ' + err.message; }
}
$('folder').addEventListener('click', pickFolder);
if (APP) {
  $('library').hidden = false;
  $('library').addEventListener('click', async () => { await syncOut(); FRAMED ? window.parent.postMessage({ ar: 'library' }, location.origin) : (location.href = 'app.html'); });
}

$('download').addEventListener('click', download);
$('start').addEventListener('click', start);
$('resume').addEventListener('click', closeMenu);
$('export').addEventListener('click', exportSaves);
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importSaves(f);
});

refresh().catch((err) => setStatus('오류: ' + err.message));
