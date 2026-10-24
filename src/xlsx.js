// 极简 xlsx 读取：只解压需要的几个 XML，按工作表返回二维字符串数组。
// 不依赖第三方库，用浏览器自带的 DecompressionStream 解压。

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function unzip(buf) {
  const b = new Uint8Array(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10), size = u32(b, p + 20);
    const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, {method, size, local});
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async name => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
    const raw = b.subarray(start, start + e.size);
    if (e.method === 0) return new TextDecoder().decode(raw);
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

const xml = s => new DOMParser().parseFromString(s, 'application/xml');
const colIndex = ref => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export async function readWorkbook(buf) {
  const read = await unzip(buf);
  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  if (ss) for (const si of xml(ss).getElementsByTagName('si')) {
    shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  }
  const rels = {};
  for (const r of xml(await read('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')) {
    rels[r.getAttribute('Id')] = r.getAttribute('Target').replace(/^\/?(xl\/)?/, 'xl/');
  }
  const sheets = {};
  for (const s of xml(await read('xl/workbook.xml')).getElementsByTagName('sheet')) {
    const doc = xml(await read(rels[s.getAttribute('r:id')]));
    const rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const cells = [];
      for (const c of row.getElementsByTagName('c')) {
        const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]?.textContent ?? '';
        const value = t === 's' ? shared[+v] : t === 'inlineStr' ? c.getElementsByTagName('t')[0]?.textContent ?? '' : v;
        cells[colIndex(c.getAttribute('r'))] = value;
      }
      rows.push(Array.from(cells, x => x ?? ''));
    }
    sheets[s.getAttribute('name')] = rows;
  }
  return sheets;
}
