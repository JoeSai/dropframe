import {readWorkbook} from './xlsx.js';
import {parseExport, intervals, worstSeconds} from './analysis.js';
import {audioLevels, frameStats, sampler, sampleTimes, reasons} from './diagnose.js';

const $ = id => document.getElementById(id);
const files = {video: null, data: null};
let report = null;   // {points, metrics, segs, worst, frames: Map<秒, dataURL>}

const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const p1 = n => `${n.toFixed(1)}%`;

// ---------- 拿文件 ----------
function take(list) {
  for (const f of list) {
    if (f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name)) files.video = f;
    else if (/\.xlsx$/i.test(f.name)) files.data = f;
  }
  $('slot-video').classList.toggle('ok', !!files.video);
  $('slot-data').classList.toggle('ok', !!files.data);
  if (files.video) $('slot-video').querySelector('span').textContent = files.video.name;
  if (files.data) $('slot-data').querySelector('span').textContent = files.data.name;
  if (files.video && files.data) start().catch(fail);
}
function fail(e) {
  console.error(e);
  $('error').textContent = e.message || String(e);
  $('error').hidden = false;
}

const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); take(e.dataTransfer.files); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); if (!$('report').hidden) take(e.dataTransfer.files); });
$('pick-btn').onclick = () => $('pick').click();
$('pick').onchange = e => take(e.target.files);
$('reset').onclick = () => location.reload();

// ---------- 分析 ----------
async function start() {
  $('error').hidden = true;
  const {points, metrics} = parseExport(await readWorkbook(await files.data.arrayBuffer()));
  if (points.length < 3) throw new Error('留存数据太少，换一份导出试试');

  const url = URL.createObjectURL(files.video);
  const video = $('video');
  video.src = url;
  await new Promise((ok, no) => { video.onloadedmetadata = ok; video.onerror = () => no(new Error('这个视频浏览器打不开，换成 mp4 试试')); });

  report = {points, metrics, segs: intervals(points), worst: worstSeconds(points), frames: new Map(), aspect: video.videoWidth / video.videoHeight};
  const last = points.at(-1).t;
  const warn = $('warn');
  warn.hidden = Math.abs(video.duration - last) <= 2.5;
  warn.textContent = `视频 ${fmt(video.duration)}，数据只到 ${fmt(last)}，可能放错了视频。`;

  $('drop').hidden = true;
  $('report').hidden = false;
  renderMetrics();
  renderWorst();
  renderChart();
  const levels = audioLevels(files.video);
  await grabFrames(url);
  await diagnose(url, await levels);
}

function renderMetrics() {
  $('metrics').innerHTML = report.metrics.map(m => `<div class="metric"><b>${m.value}</b><span>${m.label}</span></div>`).join('');
}

function renderWorst() {
  const ol = $('worst');
  if (!report.worst.length) {
    ol.innerHTML = `<li class="none">每一秒都没有比同类多掉 1 个百分点以上。${report.points[0].peer === null ? '（这份数据没有同类作品对比）' : ''}</li>`;
    return;
  }
  ol.innerHTML = report.worst.map((s, i) => `
    <li data-from="${s.from}" data-i="${i}">
      <img alt="" data-frame="${s.to}">
      <div><div class="when">${i + 1}. 第 ${fmt(s.from)}–${fmt(s.to)} 秒</div>
      <div class="what">这一秒走了 ${p1(s.lost)}，同类只走 ${p1(s.peerLost)}</div>
      <ul class="why" data-why="${i}"><li class="wait">正在检查画面和声音…</li></ul></div>
    </li>`).join('');
  ol.onclick = e => {
    const li = e.target.closest('li[data-from]');
    if (li) playFrom(+li.dataset.from);
  };
}

function playFrom(t) {
  const v = $('video');
  v.currentTime = Math.max(0, t - .3);
  v.play().catch(() => {});
}

// ---------- 曲线 + 胶片条 ----------
const GEO = {};
function renderChart() {
  const {points, segs} = report;
  const box = $('chart');
  const n = segs.length;
  const cw = Math.max(44, Math.min(72, Math.floor((box.clientWidth - 70) / n)));
  const stripH = 76;   // 格子比画面窄时裁掉两边，保留中间
  const L = 22, top = 26, plotH = 220, W = L + n * cw + 48, H = top + plotH + 26 + stripH + 8;
  const x = t => L + (t - points[0].t) * cw;
  const y = v => top + (1 - v / 100) * plotH;
  Object.assign(GEO, {L, cw, top, plotH, W, x0: points[0].t, x1: points.at(-1).t});

  const line = key => points.filter(p => p[key] !== null).map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const area = `${line('you')}L${x(points.at(-1).t)},${y(0)}L${x(points[0].t)},${y(0)}Z`;
  const gaps = segs.filter(s => s.extra !== null && s.extra >= 1)
    .map(s => `<rect x="${x(s.from)}" y="${top}" width="${cw}" height="${plotH}" fill="var(--you)" opacity="${Math.min(.32, .05 + s.extra / 30).toFixed(2)}"/>`).join('');   // 多掉得越多，颜色越深
  const badges = report.worst.map((s, i) =>
    `<g transform="translate(${x(s.from) + cw / 2},${top - 13})"><circle r="10" fill="var(--you)"/><text y="4" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${i + 1}</text></g>`).join('');
  const grid = [0, 25, 50, 75, 100].map(v =>
    `<line x1="${L}" x2="${L + n * cw}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L + n * cw + 6}" y="${y(v) + 4}" font-size="11" fill="var(--muted)">${v}%</text>`).join('');
  const every = cw >= 50 ? 1 : cw >= 30 ? 2 : 5;
  const ticks = points.filter(p => p.t % every === 0).map(p =>
    `<text x="${x(p.t)}" y="${top + plotH + 17}" font-size="11" text-anchor="middle" fill="var(--muted)">${fmt(p.t)}</text>`).join('');
  const sy = top + plotH + 26;
  const strip = segs.map(s =>
    `<rect x="${x(s.from) + 1}" y="${sy}" width="${cw - 2}" height="${stripH}" rx="3" fill="#000" opacity=".85"/>` +
    `<image data-frame="${s.to}" x="${x(s.from) + 1}" y="${sy}" width="${cw - 2}" height="${stripH}" preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round 3px)"/>`).join('');

  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="逐秒留存曲线和对应画面">
    ${grid}${gaps}
    <path d="${area}" fill="var(--you)" opacity=".07"/>
    <path d="${line('peer')}" fill="none" stroke="var(--peer)" stroke-width="2" stroke-dasharray="5 4"/>
    <path d="${line('you')}" fill="none" stroke="var(--you)" stroke-width="2.5" stroke-linejoin="round"/>
    ${badges}${ticks}
    <g class="strip">${strip}</g>
    <line id="cursor" y1="${top}" y2="${sy + stripH}" stroke="var(--hover)" stroke-width="1" opacity="0" pointer-events="none"/>
    <rect id="hit" x="${L}" y="0" width="${n * cw}" height="${H}" fill="transparent"/>
  </svg>`;
  for (const [t, src] of report.frames) setFrame(t, src);

  const hit = $('hit'), cursor = $('cursor');
  const tAt = e => {
    const r = hit.getBoundingClientRect();
    return Math.min(GEO.x1, Math.max(GEO.x0, GEO.x0 + (e.clientX - r.left) / GEO.cw));
  };
  hit.onmousemove = e => {
    const t = tAt(e), cx = GEO.L + (t - GEO.x0) * GEO.cw;
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('opacity', '.6');
    const p = points[Math.min(points.length - 1, Math.round(t - GEO.x0))];
    $('readout').textContent = `${fmt(t)}  留存 ${p1(p.you)}${p.peer === null ? '' : `  同类 ${p1(p.peer)}`}`;
    const v = $('video');
    if (v.paused) v.currentTime = t;
  };
  hit.onmouseleave = () => { cursor.setAttribute('opacity', '0'); $('readout').textContent = ''; };
  hit.onclick = e => playFrom(Math.floor(tAt(e)));
}
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => report && renderChart(), 150); });

// ---------- 抽帧：第 k 段 (k-1, k] 取 k-0.5 秒那一帧 ----------
function setFrame(t, src) {
  for (const el of document.querySelectorAll(`[data-frame="${t}"]`)) {
    if (el.tagName === 'image') el.setAttribute('href', src); else el.src = src;
  }
}
async function grabFrames(url) {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  await new Promise(ok => { v.onloadeddata = ok; });
  const w = 240, h = Math.round(w / report.aspect);
  const c = Object.assign(document.createElement('canvas'), {width: w, height: h});
  const g = c.getContext('2d');
  const segs = report.segs;
  for (let i = 0; i < segs.length; i++) {
    const t = Math.min(segs[i].to - .5, v.duration - .05);
    await new Promise(ok => { v.onseeked = ok; v.currentTime = Math.max(0, t); });
    g.drawImage(v, 0, 0, w, h);
    const src = c.toDataURL('image/jpeg', .8);
    report.frames.set(segs[i].to, src);
    setFrame(segs[i].to, src);
    $('progress').textContent = i + 1 < segs.length ? `正在抽取画面 ${i + 1}/${segs.length}` : '';
  }
  v.removeAttribute('src'); v.load();
}

// ---------- 最该看的几秒：查画面和声音 ----------
async function diagnose(url, levels) {
  if (!report.worst.length) return;
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  await new Promise(ok => { v.onloadeddata = ok; });
  const grab = sampler(v);
  for (const [i, seg] of report.worst.entries()) {
    const frames = [];
    for (const t of sampleTimes(seg.from, seg.to)) frames.push(await grab(t));
    const why = reasons(seg, frameStats(frames), levels);
    document.querySelector(`[data-why="${i}"]`).innerHTML = why.map(w => `<li>${w}</li>`).join('');
  }
  v.removeAttribute('src'); v.load();
}
