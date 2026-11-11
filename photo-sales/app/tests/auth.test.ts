import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './d1-adapter.ts';
import { consumeLoginToken, createSession, destroySession, issueLoginToken, staffFromCookie, COOKIE } from '../src/lib/auth.ts';

const NOW = new Date('2026-11-11T05:00:00Z');
function seed() {
  const t = openTestDb();
  t.raw.exec(`INSERT INTO staff_users(id, email, name, role) VALUES ('s1','staff@example.com','山田','staff'),
              ('s2','off@example.com','退職','staff')`);
  t.raw.exec(`UPDATE staff_users SET active = 0 WHERE id = 's2'`);
  return t;
}

test('ログインリンク: 登録済みだけ発行 / 1回限り / 15分で失効 / ハッシュだけ保存', async () => {
  const { db, raw } = seed();
  assert.equal(await issueLoginToken(db, 'nobody@example.com', NOW), null);      // 未登録は発行しない
  assert.equal(await issueLoginToken(db, 'off@example.com', NOW), null);         // 無効なスタッフも
  const tok = await issueLoginToken(db, ' STAFF@example.com ', NOW);             // 大文字小文字・空白は無視
  assert.match(tok!, /^[0-9a-f]{64}$/);
  assert.equal((raw.prepare('SELECT count(*) n FROM login_tokens WHERE token_hash = ?').get(tok!) as any).n, 0);  // 平文は保存しない
  assert.equal(await consumeLoginToken(db, tok!, new Date(NOW.getTime() + 60_000)), 's1');
  assert.equal(await consumeLoginToken(db, tok!, new Date(NOW.getTime() + 61_000)), null);   // 2 回目は不可
  const t2 = await issueLoginToken(db, 'staff@example.com', NOW);
  assert.equal(await consumeLoginToken(db, t2!, new Date(NOW.getTime() + 16 * 60_000)), null); // 期限切れ
  assert.equal(await consumeLoginToken(db, 'zz', NOW), null);
});

test('ログインリンクの発行は 1 時間に 5 回まで', async () => {
  const { db } = seed();
  const got = [];
  for (let i = 0; i < 7; i++) got.push(await issueLoginToken(db, 'staff@example.com', new Date(NOW.getTime() + i * 60_000)));
  assert.equal(got.filter(Boolean).length, 5);
  assert.ok(await issueLoginToken(db, 'staff@example.com', new Date(NOW.getTime() + 2 * 3600_000)));   // 時間がたてば再び可
});

test('セッション: Cookie で本人確認 / 30日で失効 / ログアウト / 無効化で即切れ', async () => {
  const { db, raw } = seed();
  const v = await createSession(db, 's1', NOW);
  const cookie = `${COOKIE}=${v}`;
  assert.equal((await staffFromCookie(db, cookie, NOW))?.email, 'staff@example.com');
  assert.equal(await staffFromCookie(db, `${COOKIE}=${'0'.repeat(64)}`, NOW), null);
  assert.equal(await staffFromCookie(db, null, NOW), null);
  assert.ok(await staffFromCookie(db, cookie, new Date(NOW.getTime() + 29 * 86400_000)));
  assert.equal(await staffFromCookie(db, cookie, new Date(NOW.getTime() + 31 * 86400_000)), null);
  raw.exec(`UPDATE staff_users SET active = 0 WHERE id = 's1'`);               // 無効にすると既存セッションも使えない
  assert.equal(await staffFromCookie(db, cookie, NOW), null);
  raw.exec(`UPDATE staff_users SET active = 1 WHERE id = 's1'`);
  await destroySession(db, cookie);
  assert.equal(await staffFromCookie(db, cookie, NOW), null);
});
