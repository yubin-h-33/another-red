// 어나더레드 웹 플레이어: 게임 데이터 다운로드(OPFS), 터치 패드, 세이브 백업/복원.
// 엔진은 assets/player.js (mkxp-z libretro + Nostalgist, build_site.py 가 패치)

const GAME_FILE = 'AnotherRed.mkxpz';
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
            const res = await fetch((manifest.base ?? './game/') + manifest.parts[i]);
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

// ---------- 로딩 로그: 검은 화면일 때 무슨 일이 일어나는지 보이게 ----------
const logLines = [];
let logOn = false;
function addLog(text) {
  if (!logOn) return;
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
window.addEventListener('unhandledrejection', (e) => addLog('오류: ' + (e.reason?.message ?? e.reason)));
function hideLog() { logOn = false; $('log').hidden = true; }

// ---------- 게임 시작 ----------
window.__arGame = async () => (await (await root()).getFileHandle(GAME_FILE)).getFile();
window.__arStarted = (z) => {
  nost = z;
  $('pad').hidden = false;
};

async function start() {
  $('start').disabled = true;
  await navigator.storage.persist?.();
  // 무음 스위치가 켜져 있어도 소리가 나도록
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  // 번들이 처음 한 번 강제로 새로고침하는 단계를 건너뛴다 (coi 는 이미 확인됨)
  sessionStorage.setItem('nostalgist status for mkxp-z @ ' + location.href, 'ready');
  $('menu').hidden = true;
  $('pad').hidden = false;
  logOn = true;
  $('log').hidden = false;
  addLog('엔진 불러오는 중… (처음엔 1~2분 걸릴 수 있어요)');
  await import('./assets/player.js?v=' + (manifest?.hash ?? '').slice(0, 8));
}

function openMenu() {
  if (!nost) return;
  try { nost.pause(); } catch {}
  releaseAll();
  $('menu').hidden = false;
  refresh();
}
function closeMenu() {
  $('menu').hidden = true;
  try { nost.resume(); } catch {}
}

// ---------- 터치 패드 ----------
const held = new Map(); // pointerId -> button
// 아주 짧은 탭은 한 프레임 안에 눌림/뗌이 끝나 게임이 못 읽으므로 최소 80ms 는 누른 상태로 둔다
const downAt = new Map();
function press(btn, down) {
  if (!nost) return;
  if (down && logOn) hideLog();
  const canvas = nost.getCanvas?.();
  if (canvas && document.activeElement !== canvas) canvas.focus?.();
  if (down) {
    downAt.set(btn, performance.now());
  } else {
    const wait = 80 - (performance.now() - (downAt.get(btn) ?? 0));
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
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

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
    if (path === GAME_FILE || path.startsWith('.')) continue;
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
    const files = readZip(await file.arrayBuffer()).filter((f) => f.name !== GAME_FILE);
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
