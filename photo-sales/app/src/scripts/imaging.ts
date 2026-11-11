// iPhone のブラウザ内での画像処理 (サーバーの CPU を使わない)。
// 原本・プレビュー・サムネを Canvas で作り直すので、EXIF (位置情報を含む) は残らない。

/** Canvas の面積上限 (iOS Safari は約 1,677 万画素まで)。超える写真は縮小して扱う */
export const MAX_CANVAS_PIXELS = 16_000_000;

export function fitWithin(w: number, h: number, longEdge: number, maxPixels = Infinity) {
  const s = Math.min(1, longEdge / Math.max(w, h));
  let ow = Math.max(1, Math.round(w * s)), oh = Math.max(1, Math.round(h * s));
  if (ow * oh > maxPixels) {                       // 面積上限を超えるときは切り捨てで確実に収める
    const k = Math.sqrt(maxPixels / (ow * oh));
    ow = Math.max(1, Math.floor(ow * k)); oh = Math.max(1, Math.floor(oh * k));
  }
  return { w: ow, h: oh };
}

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** HEIC/HEIF か (ISO-BMFF の ftyp ブランドで判定。拡張子・MIME が当てにならない場合に備える) */
export function isHeic(buf: ArrayBuffer, file?: { name?: string; type?: string }): boolean {
  if (buf.byteLength >= 12) {
    const v = new DataView(buf);
    if (v.getUint32(4) === 0x66747970) {                              // 'ftyp'
      const brand = String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11));
      if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return true;
    }
  }
  return /heic|heif/i.test(file?.type ?? '') || /\.(heic|heif)$/i.test(file?.name ?? '');
}

/** 撮影日時 (EXIF DateTimeOriginal) を UTC の ISO 文字列で。JPEG と HEIC に対応。無ければ null */
export function exifTakenAt(buf: ArrayBuffer): string | null {
  try {
    const head = new DataView(buf, 0, Math.min(buf.byteLength, 12));
    if (head.byteLength >= 2 && head.getUint16(0) === 0xffd8) return jpegExifTime(buf);
    if (head.byteLength >= 12 && head.getUint32(4) === 0x66747970) return heicExifTime(buf);
  } catch { /* 読めなければ null */ }
  return null;
}

function jpegExifTime(buf: ArrayBuffer): string | null {
  const v = new DataView(buf, 0, Math.min(buf.byteLength, 131072));
  let o = 2;
  while (o + 4 < v.byteLength) {
    const marker = v.getUint16(o), len = v.getUint16(o + 2);
    if ((marker & 0xff00) !== 0xff00) return null;
    if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return tiffDate(v, o + 10);
    o += 2 + len;
  }
  return null;
}

/** HEIC: meta → iinf で 'Exif' アイテムを探し、iloc でその位置を引く */
function heicExifTime(buf: ArrayBuffer): string | null {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const tag = (p: number) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
  const boxes = (start: number, end: number) => {
    const out: { type: string; body: number; end: number }[] = [];
    let p = start;
    while (p + 8 <= end) {
      let size = v.getUint32(p); const type = tag(p + 4); let hdr = 8;
      if (size === 1) { size = Number(v.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type, body: p + hdr, end: p + size });
      p += size;
    }
    return out;
  };
  const meta = boxes(0, v.byteLength).find((b) => b.type === 'meta');
  if (!meta) return null;
  const kids = boxes(meta.body + 4, meta.end);                          // meta は FullBox (4 バイト分ずらす)
  const iinf = kids.find((b) => b.type === 'iinf'), iloc = kids.find((b) => b.type === 'iloc');
  if (!iinf || !iloc) return null;

  // Exif アイテムの ID
  const iinfVer = v.getUint8(iinf.body);
  let q = iinf.body + 4 + (iinfVer === 0 ? 2 : 4);
  let exifId = -1;
  for (const infe of boxes(q, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const ver = v.getUint8(infe.body);
    if (ver < 2) continue;
    const id = ver === 2 ? v.getUint16(infe.body + 4) : v.getUint32(infe.body + 4);
    const typeAt = infe.body + 4 + (ver === 2 ? 2 : 4) + 2;
    if (tag(typeAt) === 'Exif') { exifId = id; break; }
  }
  if (exifId < 0) return null;

  // iloc から位置
  const ver = v.getUint8(iloc.body);
  q = iloc.body + 4;
  const sizes = v.getUint8(q), sizes2 = v.getUint8(q + 1); q += 2;
  const offSz = sizes >> 4, lenSz = sizes & 15, baseSz = sizes2 >> 4, idxSz = ver === 1 || ver === 2 ? sizes2 & 15 : 0;
  const rd = (p: number, n: number) => (n === 0 ? 0 : n === 4 ? v.getUint32(p) : n === 8 ? Number(v.getBigUint64(p)) : n === 2 ? v.getUint16(p) : v.getUint8(p));
  let count: number;
  if (ver < 2) { count = v.getUint16(q); q += 2; } else { count = v.getUint32(q); q += 4; }
  for (let i = 0; i < count; i++) {
    let id: number;
    if (ver < 2) { id = v.getUint16(q); q += 2; } else { id = v.getUint32(q); q += 4; }
    if (ver === 1 || ver === 2) q += 2;                                   // construction_method
    q += 2;                                                               // data_reference_index
    const base = rd(q, baseSz); q += baseSz;
    const ext = v.getUint16(q); q += 2;
    let first: { off: number; len: number } | null = null;
    for (let e = 0; e < ext; e++) {
      if (idxSz) q += idxSz;
      const off = rd(q, offSz); q += offSz;
      const len = rd(q, lenSz); q += lenSz;
      if (!first) first = { off: base + off, len };
    }
    if (id === exifId && first) {
      const skip = v.getUint32(first.off);                                // 先頭 4 バイト = TIFF ヘッダまでのバイト数
      return tiffDate(v, first.off + 4 + skip);
    }
  }
  return null;
}

function tiffDate(v: DataView, t: number): string | null {
  const le = v.getUint16(t) === 0x4949;
  const g16 = (p: number) => v.getUint16(p, le), g32 = (p: number) => v.getUint32(p, le);
  const findTag = (ifd: number, tag: number): number | null => {
    const n = g16(ifd);
    for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (g16(e) === tag) return e; }
    return null;
  };
  const exifPtr = findTag(t + g32(t + 4), 0x8769);
  if (exifPtr === null) return null;
  const dt = findTag(t + g32(exifPtr + 8), 0x9003);
  if (dt === null) return null;
  const off = t + g32(dt + 8);
  let s = '';
  for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(off + i));
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function watermark(ctx: CanvasRenderingContext2D, w: number, h: number, light: boolean) {
  const size = Math.max(14, Math.round(Math.max(w, h) / (light ? 9 : 14)));
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 6);
  ctx.font = `800 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1, size / 16);
  ctx.strokeStyle = `rgba(0,0,0,${light ? 0.22 : 0.3})`;
  ctx.fillStyle = `rgba(255,255,255,${light ? 0.3 : 0.4})`;
  const step = size * 2.6, span = Math.hypot(w, h);
  for (let y = -span; y < span; y += step) {
    for (let x = -span; x < span; x += size * 9) {
      const xx = x + ((Math.round(y / step) % 2) * size * 4.5);
      ctx.strokeText('A-ONE CIRCUIT', xx, y); ctx.fillText('A-ONE CIRCUIT', xx, y);
    }
  }
  ctx.restore();
}

async function toJpeg(src: ImageBitmap, w: number, h: number, q: number, wm: 'none' | 'preview' | 'thumb'): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  if (wm !== 'none') watermark(ctx, w, h, wm === 'thumb');
  const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
  c.width = 0; c.height = 0;                       // iOS のメモリを早めに返す
  if (!blob) throw new Error('encode_failed');
  return blob;
}

let heifLib: any = null;
/** libheif (WASM) で HEIC を読む。Safari は端末標準のデコーダで読めるので通常は使わない (PC の Chrome 等の保険) */
async function decodeHeicWasm(buf: ArrayBuffer): Promise<ImageBitmap> {
  if (!heifLib) { const m: any = await import('libheif-js/wasm-bundle'); heifLib = m.default ?? m; }
  const imgs = new heifLib.HeifDecoder().decode(new Uint8Array(buf));
  if (!imgs?.length) throw new Error('heic_decode');
  const img = imgs[0];
  const w = img.get_width(), h = img.get_height();
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const data = ctx.createImageData(w, h);
  await new Promise<void>((res, rej) => img.display(data, (r: unknown) => (r ? res() : rej(new Error('heic_decode')))));
  ctx.putImageData(data, 0, 0);
  const bmp = await createImageBitmap(c);
  c.width = 0; c.height = 0;
  return bmp;
}

export type DecodeVia = 'jpeg' | 'heic-native' | 'heic-wasm';

async function decode(file: File, buf: ArrayBuffer): Promise<{ bmp: ImageBitmap; via: DecodeVia }> {
  if (isHeic(buf, file)) {
    try {
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/heic' }), { imageOrientation: 'from-image' } as any);
      if (bmp.width > 0 && bmp.height > 0) return { bmp, via: 'heic-native' };
    } catch { /* 端末が HEIC を読めない → WASM へ */ }
    return { bmp: await decodeHeicWasm(buf), via: 'heic-wasm' };
  }
  try { return { bmp: await createImageBitmap(file, { imageOrientation: 'from-image' } as any), via: 'jpeg' }; }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return { bmp: await createImageBitmap(img), via: 'jpeg' };
    } finally { URL.revokeObjectURL(url); }
  }
}

export interface Processed { body: Blob; meta: Record<string, unknown>; via: DecodeVia }

/** 1 枚を処理: 原本 (EXIF 除去) + 透かし付きプレビュー + サムネ + SHA-256 / CRC32 */
export async function processImage(file: File, buf: ArrayBuffer, sha256: string): Promise<Processed> {
  const { bmp, via } = await decode(file, buf);
  try {
    const o = fitWithin(bmp.width, bmp.height, Infinity, MAX_CANVAS_PIXELS);
    const p = fitWithin(bmp.width, bmp.height, 1280);
    const t = fitWithin(bmp.width, bmp.height, 400);
    const original = await toJpeg(bmp, o.w, o.h, 0.92, 'none');
    const preview = await toJpeg(bmp, p.w, p.h, 0.75, 'preview');
    const thumb = await toJpeg(bmp, t.w, t.h, 0.7, 'thumb');
    const crc = crc32(new Uint8Array(await original.arrayBuffer()));
    return {
      body: new Blob([original, preview, thumb]),
      meta: {
        sha256, crc32: crc, takenAt: exifTakenAt(buf) ?? (file.lastModified ? new Date(file.lastModified).toISOString() : null),
        width: o.w, height: o.h, sizes: [original.size, preview.size, thumb.size],
      },
      via,
    };
  } finally { bmp.close(); }
}
