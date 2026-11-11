import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './d1-adapter.ts';
import { customerImageKey, getPublicGroup, getTvState, tvImageKey } from '../src/lib/public.ts';
import { createGroup, parseGroupForm, setPublished, updateGroup } from '../src/lib/groups.ts';
import { parseUploadMeta } from '../src/lib/photos.ts';
import { crc32, exifTakenAt, fitWithin } from '../src/scripts/imaging.ts';
import { readFileSync } from 'node:fs';

const NOW = new Date('2026-11-11T05:00:00Z');   // JST 11/11 14:00
const T = '0123456789abcdef0123456789abcdef';   // tv token
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const BASE = { shoot_date: '2026-11-11', start_time: '14:30', name: 'A', headcount: '4', plan: 'rental' };

async function seed(extra: Record<string, string> = { consent_shoot: 'on', consent_online: 'on', consent_tv: 'on' }) {
  const t = openTestDb();
  t.raw.exec(`INSERT INTO staff_users(id, email, name, role) VALUES ('s1','a@x.jp','A','admin')`);
  t.raw.exec(`UPDATE tv_state SET tv_token = '${T}'`);
  const g = parseGroupForm(form({ ...BASE, ...extra })) as any;
  const id = await createGroup(t.db, g, 's1', NOW);
  t.raw.exec(`INSERT INTO photos(id, group_id, sha256, original_key, preview_key, thumb_key, taken_at)
              VALUES ('p1','${id}','s1','o1','pv1','t1','2026-11-11T04:00:00Z'), ('p2','${id}','s2','o2','pv2','t2','2026-11-11T04:01:00Z')`);
  const token = (t.raw.prepare('SELECT qr_token q FROM groups WHERE id = ?').get(id) as any).q as string;
  return { ...t, id, token };
}

test('お客様ページ: 公開前は準備中 / 公開で open / 同意を外すと closed / 30日で closed', async () => {
  const { db, id, token, raw } = await seed();
  assert.equal((await getPublicGroup(db, token, NOW))?.state, 'preparing');
  assert.equal(await customerImageKey(db, token, 'p1', 'thumb', NOW), null);          // 準備中は画像も出さない
  assert.ok(await setPublished(db, id, true, 's1', NOW));
  assert.equal((await getPublicGroup(db, token, NOW))?.state, 'open');
  assert.equal(await customerImageKey(db, token, 'p1', 'thumb', NOW), 't1');
  assert.equal(await customerImageKey(db, token, 'p1', 'preview', NOW), 'pv1');
  assert.equal(await customerImageKey(db, token, 'p1', 'original', NOW), null);       // 原本は出ない
  assert.equal(await getPublicGroup(db, 'x', NOW), null);
  assert.equal((await getPublicGroup(db, token, new Date('2026-12-12T00:00:00Z')))?.state, 'closed');
  // 同意を外して更新 → 公開は自動で止まる (DB の CHECK に頼る前にアプリが戻す)
  await updateGroup(db, id, parseGroupForm(form({ ...BASE, consent_shoot: 'on', consent_tv: 'on' })) as any, 's1', NOW);
  assert.equal((raw.prepare('SELECT status s FROM groups WHERE id = ?').get(id) as any).s, 'hidden');
  assert.equal((await getPublicGroup(db, token, NOW))?.state, 'closed');
});

test('他団体の写真は、自分の QR では見えない', async () => {
  const a = await seed();
  await setPublished(a.db, a.id, true, 's1', NOW);
  const idB = await createGroup(a.db, parseGroupForm(form({ ...BASE, name: 'B', consent_shoot: 'on', consent_online: 'on' })) as any, 's1', NOW);
  await setPublished(a.db, idB, true, 's1', NOW);
  const tokB = (a.raw.prepare('SELECT qr_token q FROM groups WHERE id = ?').get(idB) as any).q;
  assert.equal(await customerImageKey(a.db, tokB, 'p1', 'thumb', NOW), null);         // B の QR で A の写真 ID を指定しても不可
});

test('公開は同意が揃っているときだけ (未成年は保護者同意が必要)', async () => {
  const { db, id } = await seed({ consent_shoot: 'on', consent_online: 'on', has_minor: 'on' });
  assert.equal(await setPublished(db, id, true, 's1', NOW), false);
  await updateGroup(db, id, parseGroupForm(form({ ...BASE, consent_shoot: 'on', consent_online: 'on', has_minor: 'on', guardian_consent: 'on' })) as any, 's1', NOW);
  assert.equal(await setPublished(db, id, true, 's1', NOW), true);
});

test('テレビ: tv_ok の団体の写真だけ・本日の分・新しい順 / 停止・手動', async () => {
  const a = await seed();
  let s = await getTvState(a.db, T, NOW);
  assert.deepEqual(s!.groups.map((g) => g.photos), [['p1', 'p2']]);                    // 未公開でも TV 同意があれば出る
  assert.equal(await tvImageKey(a.db, T, 'p1'), 'pv1');
  assert.equal(await getTvState(a.db, 'f'.repeat(32), NOW), null);                     // 別トークンは不可
  assert.equal(await tvImageKey(a.db, 'f'.repeat(32), 'p1'), null);
  // 2 団体目 (TV 同意なし) は出ない。3 団体目 (後からアップロード) が先頭
  const idB = await createGroup(a.db, parseGroupForm(form({ ...BASE, name: 'B', consent_shoot: 'on', consent_online: 'on' })) as any, 's1', NOW);
  a.raw.exec(`INSERT INTO photos(id, group_id, sha256, original_key, preview_key, thumb_key) VALUES ('pb','${idB}','sb','ob','pvb','tb')`);
  const idC = await createGroup(a.db, parseGroupForm(form({ ...BASE, name: 'C', consent_shoot: 'on', consent_tv: 'on' })) as any, 's1', NOW);
  a.raw.exec(`INSERT INTO photos(id, group_id, sha256, original_key, preview_key, thumb_key) VALUES ('pc','${idC}','sc','oc','pvc','tc')`);
  a.raw.exec(`UPDATE groups SET tv_priority_at = '2026-11-11T05:00:00Z' WHERE id = '${idC}'`);
  a.raw.exec(`UPDATE groups SET tv_priority_at = '2026-11-11T04:00:00Z' WHERE id = '${a.id}'`);
  s = await getTvState(a.db, T, NOW);
  assert.deepEqual(s!.groups.map((g) => g.name), ['C', 'A']);
  assert.equal(await tvImageKey(a.db, T, 'pb'), null);                                  // TV 同意なしの写真は出ない
  // 翌日になれば「本日」の団体ではなくなる
  assert.equal((await getTvState(a.db, T, new Date('2026-11-12T05:00:00Z')))!.groups.length, 0);
  a.raw.exec(`UPDATE tv_state SET mode = 'manual', group_id = '${a.id}'`);
  assert.deepEqual((await getTvState(a.db, T, new Date('2026-11-12T05:00:00Z')))!.groups.map((g) => g.name), ['A']);
  a.raw.exec(`UPDATE tv_state SET mode = 'off'`);
  assert.equal((await getTvState(a.db, T, NOW))!.groups.length, 0);
  assert.equal(await tvImageKey(a.db, T, 'p1'), null);
});

test('アップロードのメタ検証', () => {
  const ok = { sha256: 'a'.repeat(64), crc32: 123, takenAt: '2026-11-11T04:00:00Z', width: 4032, height: 3024, sizes: [1000, 200, 50] };
  const enc = (m: unknown) => encodeURIComponent(JSON.stringify(m));
  assert.equal(typeof parseUploadMeta(enc(ok), 1250), 'object');
  assert.equal(parseUploadMeta(enc(ok), 1251), 'length_mismatch');
  assert.equal(parseUploadMeta(enc({ ...ok, sha256: 'zz' }), 1250), 'sha256');
  assert.equal(parseUploadMeta(enc({ ...ok, sizes: [1000, 2_000_000, 50] }), 2_001_050), 'too_large');
  assert.equal(parseUploadMeta(enc({ ...ok, width: 0 }), 1250), 'dimensions');
  assert.equal(parseUploadMeta('%7B', 1), 'meta');
  assert.equal(parseUploadMeta(null, 1), 'meta');
});

test('画像処理の部品: CRC32 / 縮小 / EXIF 撮影時刻 (JST→UTC)', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.deepEqual(fitWithin(4032, 3024, 1280), { w: 1280, h: 960 });
  assert.deepEqual(fitWithin(3024, 4032, 400), { w: 300, h: 400 });
  const big = fitWithin(8000, 6000, Infinity, 16_000_000);                              // 4800 万画素は 1,600 万画素以下に
  assert.ok(big.w * big.h <= 16_000_000);
  const buf = readFileSync(new URL('./fixtures/exif.jpg', import.meta.url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  assert.equal(exifTakenAt(ab), '2026-11-11T05:31:05.000Z');
  assert.equal(exifTakenAt(new ArrayBuffer(10)), null);
});
