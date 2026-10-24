// 给掉得快的那几秒找可能的原因：声音、画面动没动、黑屏白闪、切镜。全是本地规则，不用模型。

const SAMPLES = 4;          // 每秒取几帧小图看画面变化
const W = 48, H = 27;       // 小图尺寸，够判断动没动

// 每秒的音量（dBFS）。解不出声音时返回 null。
export async function audioLevels(file) {
  if (file.size > 600e6) return null;   // 太大的文件不解码整条音轨，免得卡死
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const ch = buf.getChannelData(0), sr = buf.sampleRate, out = [];
    for (let s = 0; s * sr < ch.length; s++) {
      let sum = 0;
      const a = s * sr, b = Math.min(ch.length, a + sr);
      for (let i = a; i < b; i++) sum += ch[i] * ch[i];
      out.push(10 * Math.log10(sum / Math.max(1, b - a) + 1e-12));
    }
    return out;
  } catch {
    return null;
  }
}

// 一秒内的画面：相邻小图的平均像素差、最大差、平均亮度。
export function frameStats(frames) {
  const luma = frames.map(d => {
    const g = new Float32Array(W * H);
    for (let i = 0; i < g.length; i++) g[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
    return g;
  });
  const diffs = [];
  for (let k = 1; k < luma.length; k++) {
    let s = 0;
    for (let i = 0; i < luma[k].length; i++) s += Math.abs(luma[k][i] - luma[k - 1][i]);
    diffs.push(s / luma[k].length);
  }
  const bright = luma.map(g => g.reduce((a, b) => a + b, 0) / g.length);
  return {motion: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0, maxDiff: Math.max(0, ...diffs), bright};
}

// 在 video 上按时间取一帧小图的像素
export function sampler(video) {
  const c = Object.assign(document.createElement('canvas'), {width: W, height: H});
  const g = c.getContext('2d', {willReadFrequently: true});
  return async t => {
    await new Promise(ok => { video.onseeked = ok; video.currentTime = Math.max(0, Math.min(t, video.duration - .05)); });
    g.drawImage(video, 0, 0, W, H);
    return g.getImageData(0, 0, W, H).data;
  };
}
export const sampleTimes = (from, to) => Array.from({length: SAMPLES}, (_, i) => from + (to - from) * (i + .5) / SAMPLES);

// 把一秒的数据翻译成人话。levels 是全片每秒音量，seg 是 (from, to] 这一段。
export function reasons(seg, stats, levels) {
  const out = [];
  if (stats) {
    const dark = stats.bright.filter(b => b < 18).length, light = stats.bright.filter(b => b > 240).length;
    if (dark >= 2) out.push('画面大部分时间是黑的');
    else if (light >= 2) out.push('画面大部分时间是白的');
    // 一次大跳变是切镜；每一帧都变很多，是画面一直在快速变化
    if (stats.maxDiff > 45 && stats.motion < stats.maxDiff * .6) out.push('这一秒里切了镜头或转场');
    if (stats.motion > 18) out.push('画面一直在快速变化，观众可能来不及看清');
    else if (stats.motion < 1.2) out.push('画面几乎没动');
  }
  if (levels) {
    const db = levels[Math.min(levels.length - 1, seg.from)];
    const loud = levels.filter(x => x > -60).sort((a, b) => a - b);
    const typical = loud.length ? loud[Math.floor(loud.length / 2)] : null;
    if (db < -50) out.push('几乎没有声音');
    else if (typical !== null && db < typical - 10) out.push('比全片平时安静很多');
  }
  if (seg.from < 2 && !out.length) out.push('开头 2 秒是观众决定划不划走的时候，看看这一刻能不能一眼看懂在讲什么');
  if (!out.length) out.push('画面和声音没发现明显问题，看看这一秒说的内容');
  return out;
}
