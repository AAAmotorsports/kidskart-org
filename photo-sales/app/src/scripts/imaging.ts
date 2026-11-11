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

/** JPEG の EXIF 撮影日時 (DateTimeOriginal)。iPhone は現地時間 (JST) で書く */
export function exifTakenAt(buf: ArrayBuffer): string | null {
  try {
    const v = new DataView(buf, 0, Math.min(buf.byteLength, 131072));
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      const marker = v.getUint16(o), len = v.getUint16(o + 2);
      if ((marker & 0xff00) !== 0xff00) return null;
      if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return tiffDate(v, o + 10);
      o += 2 + len;
    }
  } catch { /* 読めなければ null */ }
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

async function decode(file: File): Promise<ImageBitmap> {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' } as any); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return await createImageBitmap(img);
    } finally { URL.revokeObjectURL(url); }
  }
}

export interface Processed { body: Blob; meta: Record<string, unknown> }

/** 1 枚を処理: 原本 (EXIF 除去) + 透かし付きプレビュー + サムネ + SHA-256 / CRC32 */
export async function processImage(file: File, buf: ArrayBuffer, sha256: string): Promise<Processed> {
  const bmp = await decode(file);
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
    };
  } finally { bmp.close(); }
}
