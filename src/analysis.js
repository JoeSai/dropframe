// 把抖音「内容吸引力数据」导出表变成逐秒留存，再找出比同类掉得快的那几秒。

const pct = v => {
  const n = parseFloat(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : null;
};
const seconds = v => {
  const parts = String(v).trim().split(':').map(Number);
  return parts.some(Number.isNaN) ? null : parts.reduce((s, x) => s * 60 + x, 0);
};

export function parseExport(sheets) {
  const all = Object.entries(sheets);
  const [, rows] = all.find(([name]) => name.includes('留存'))
    ?? all.find(([, r]) => r[0]?.some(h => String(h).includes('留存'))) ?? [];
  if (!rows) throw new Error('表里没有「留存分析」，请导出单条作品的「内容吸引力数据」');
  const head = rows[0].map(String);
  const ti = head.findIndex(h => h.includes('时间'));
  const yi = head.findIndex(h => h === '留存' || (h.includes('留存') && !h.includes('同类')));
  const pi = head.findIndex(h => h.includes('同类'));
  if (ti < 0 || yi < 0) throw new Error('「留存分析」表缺少「时间」或「留存」列');

  let points = rows.slice(1)
    .map(r => ({t: seconds(r[ti]), you: pct(r[yi]), peer: pi < 0 ? null : pct(r[pi])}))
    .filter(p => p.t !== null && p.you !== null)
    .sort((a, b) => a.t - b.t);
  // 有的导出把百分比存成 0–1 的小数
  if (points.length && Math.max(...points.map(p => p.you)) <= 1.0001) {
    points = points.map(p => ({...p, you: p.you * 100, peer: p.peer === null ? null : p.peer * 100}));
  }

  const metrics = [];
  const [, m] = all.find(([name]) => name.includes('指标')) ?? [];
  if (m?.length >= 2) m[0].forEach((label, i) => label && metrics.push({label: String(label), value: String(m[1][i] ?? '')}));
  return {points, metrics};
}

// 第 k 段是 (k-1, k] 秒：这一秒里走掉的观众，占总观众的百分点。
export function intervals(points) {
  const out = [];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k];
    const lost = a.you - b.you;
    const peerLost = a.peer === null || b.peer === null ? null : a.peer - b.peer;
    out.push({from: a.t, to: b.t, lost, peerLost, extra: peerLost === null ? null : lost - peerLost});
  }
  return out;
}

// 比同类多走 1 个百分点以上的段，按多走的量排序。
export function worstSeconds(points, limit = 3) {
  return intervals(points)
    .filter(s => s.extra !== null && s.extra >= 1)
    .sort((a, b) => b.extra - a.extra)
    .slice(0, limit);
}

export const at = (points, t) => points.find(p => p.t === t);
