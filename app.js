// 앱 전용 게임 목록: Games 폴더의 롬과, 이미 들여온 RPG Maker 게임(OPFS 의 .mkxpz)을 보여준다.
const APP = window.webkit?.messageHandlers?.ar;
if (new URLSearchParams(location.search).has('debug')) sessionStorage.setItem('ar-debug', '1');
const $ = (id) => document.getElementById(id);
const BUILTIN = 'AnotherRed.mkxpz';
const SYSTEMS = {
  nds: ['nds', '닌텐도 DS'], gba: ['gba', '게임보이 어드밴스'], gb: ['gb', '게임보이'], gbc: ['gb', '게임보이 컬러'],
  nes: ['nes', '패미컴'], sfc: ['snes', '슈퍼패미컴'], smc: ['snes', '슈퍼패미컴'],
};
const ext = (name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const base = (name) => name.slice(0, name.lastIndexOf('.'));
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + 'MB';
const gameUrl = (name) => '/games/' + encodeURIComponent(name);

// zip 안의 파일 이름들 (끝부분의 목록만 읽는다)
async function zipNames(name, size) {
  const from = Math.max(0, size - 65557);
  const tail = await (await fetch(gameUrl(name), { headers: { Range: `bytes=${from}-${size - 1}` } })).arrayBuffer();
  const v = new DataView(tail);
  let e = tail.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) return [];
  const cdSize = v.getUint32(e + 12, true), cdOff = v.getUint32(e + 16, true);
  const cd = cdOff >= from ? tail.slice(cdOff - from, cdOff - from + cdSize)
    : await (await fetch(gameUrl(name), { headers: { Range: `bytes=${cdOff}-${cdOff + cdSize - 1}` } })).arrayBuffer();
  const c = new DataView(cd), dec = new TextDecoder(), names = [];
  for (let p = 0; p + 46 <= cd.byteLength && c.getUint32(p, true) === 0x02014b50;) {
    const n = c.getUint16(p + 28, true);
    names.push(dec.decode(new Uint8Array(cd, p + 46, n)));
    p += 46 + n + c.getUint16(p + 30, true) + c.getUint16(p + 32, true);
  }
  return names;
}

async function classify({ name, size }) {
  const x = ext(name);
  if (SYSTEMS[x]) return { kind: SYSTEMS[x][1], href: `rom.html?core=${SYSTEMS[x][0]}&game=${encodeURIComponent(name)}` };
  const rpg = { kind: 'RPG Maker (처음 열 때 준비 시간이 걸려요)', href: `index.html?game=${encodeURIComponent(base(name) + '.mkxpz')}&src=${encodeURIComponent(name)}` };
  if (x === 'mkxpz') return rpg;
  if (x === 'zip') {
    const names = await zipNames(name, size).catch(() => []);
    const isGame = (n) => /^(Game\.ini|mkxp\.json|Data\/)/i.test(n);
    if (names.some(isGame)) return rpg;
    if (names.some((n) => isGame(n.slice(n.indexOf('/') + 1)))) return { kind: 'zip 안에 폴더가 한 겹 더 있어요. 게임 폴더 "안의 내용"만 묶어 주세요.' };
    const rom = names.map(ext).find((e) => SYSTEMS[e]);
    if (rom) return { kind: SYSTEMS[rom][1] + ' (zip)', href: `rom.html?core=${SYSTEMS[rom][0]}&game=${encodeURIComponent(name)}` };
  }
  return { kind: '지원하지 않는 형식이에요' };
}

function row({ title, kind, href, remove }) {
  const el = document.createElement('div');
  el.className = 'game' + (href ? '' : ' off');
  el.innerHTML = '<div class="info"><div class="name"></div><div class="kind"></div></div>';
  el.querySelector('.name').textContent = title;
  el.querySelector('.kind').textContent = kind;
  if (href) el.querySelector('.info').addEventListener('click', () => openGame(href));
  if (href && live.has(href)) el.querySelector('.kind').textContent += ' · 켜져 있음';
  if (remove) {
    const b = document.createElement('button');
    b.textContent = '삭제';
    b.addEventListener('click', async () => {
      if (!confirm(`"${title}" 게임 파일을 지울까요? 세이브는 남아요.`)) return;
      if (href) closeGame(href);
      await remove();
      load();
    });
    el.append(b);
  }
  return el;
}

// 열어 둔 게임들. 목록으로 돌아와도 끄지 않아서, 다시 누르면 바로 이어진다 (최근 2개까지).
const live = new Map(); // href -> iframe
const say = (frame, what) => frame.contentWindow?.postMessage({ ar: what }, location.origin);
function insets(frame) {
  // iframe 안에서는 노치/홈바 여백 값이 0 으로 나올 수 있어서 직접 넘겨 준다
  const cs = getComputedStyle($('probe'));
  const st = frame.contentDocument?.documentElement.style;
  if (!st) return;
  st.setProperty('--sat', cs.paddingTop); st.setProperty('--sar', cs.paddingRight);
  st.setProperty('--sab', cs.paddingBottom); st.setProperty('--sal', cs.paddingLeft);
  frame.contentWindow.dispatchEvent(new Event('resize'));
}
function closeGame(href) {
  live.get(href)?.remove();
  live.delete(href);
}
function openGame(href) {
  let frame = live.get(href);
  live.delete(href);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.allow = 'cross-origin-isolated; autoplay';
    frame.addEventListener('load', () => insets(frame));
    frame.src = href;
    $('frames').append(frame);
  }
  live.set(href, frame); // 가장 최근 것이 맨 뒤
  for (const old of [...live.keys()].slice(0, -2)) closeGame(old);
  frame.classList.remove('off'); // display:none 으로 숨기면 다시 보일 때 화면이 안 그려진다
  $('lib').hidden = true;
  insets(frame);
  say(frame, 'show');
}
function showLibrary() {
  for (const frame of live.values()) {
    if (!frame.classList.contains('off')) say(frame, 'hide');
    frame.classList.add('off');
  }
  $('lib').hidden = false;
  load();
}
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.ar === 'library') showLibrary();
});
window.addEventListener('resize', () => live.forEach(insets));

async function load() {
  const rows = [row({ title: '포켓몬스터 어나더 레드', kind: 'RPG Maker', href: 'index.html' })];
  const root = await navigator.storage.getDirectory();
  const files = await (await fetch('/games/', { cache: 'no-store' })).json();
  const pending = new Set(files.map((f) => base(f.name) + '.mkxpz'));
  // 이미 들여온 RPG Maker 게임
  for await (const [name, h] of root.entries()) {
    if (h.kind !== 'file' || !name.endsWith('.mkxpz') || name === BUILTIN || pending.has(name)) continue;
    rows.push(row({
      title: base(name), kind: 'RPG Maker · ' + mb((await h.getFile()).size),
      href: `index.html?game=${encodeURIComponent(name)}`, remove: () => root.removeEntry(name),
    }));
  }
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const c = await classify(f);
    rows.push(row({
      title: base(f.name) || f.name, kind: `${c.kind} · ${mb(f.size)}`, href: c.href,
      remove: async () => {
        await fetch(gameUrl(f.name), { method: 'DELETE' });
        await root.removeEntry(base(f.name) + '.mkxpz').catch(() => {});
      },
    }));
  }
  $('games').replaceChildren(...rows);
}

function showFolder(info) {
  $('notice').hidden = info.outside;
  $('save-line').hidden = !info.outside;
  $('save-line').textContent = `세이브 저장 위치: ${info.label} · 앱을 지워도 남아요`;
  $('folder2').textContent = info.outside ? '세이브 폴더 바꾸기' : '세이브 폴더 고르기';
}

$('add').addEventListener('click', async () => {
  const names = await APP.postMessage('import');
  if (names?.length) $('hint').textContent = `${names.length}개 추가했어요.`;
  load();
});
for (const id of ['folder', 'folder2']) {
  $(id).addEventListener('click', async () => {
    const info = await APP.postMessage('pick');
    if (info) showFolder(info);
  });
}
// 앱이 새 버전을 받아 두면 알려 준다. 누르면 켜 둔 게임은 꺼지고 새 버전으로 다시 열린다.
window.arOnUpdate = () => ($('update').hidden = false);
if (window.arUpdateReady) window.arOnUpdate();
$('update').addEventListener('click', () => {
  if (live.size && !confirm('적용하면 켜 둔 게임이 꺼져요. 세이브하지 않은 진행은 사라져요. 적용할까요?')) return;
  APP.postMessage('applyUpdate');
});
window.addEventListener('pageshow', () => load().catch((err) => ($('hint').textContent = '오류: ' + err.message)));
if (APP) APP.postMessage('folder').then(showFolder);
