# A-ONE 走行写真販売 — 開発時の恒久指針

会話履歴がリセットされても、ここを起点に判断してください。
設計の全体は `DESIGN.md`、画面は `docs/SCREENS.md`、DB は `db/`。

**aone (予約システム) とは別アプリ。** Supabase・Worker・R2・Stripe はすべて別。
`aone/` 配下のファイルを変更しない。`aone/app/wrangler.jsonc` の値をコピーしない。

## オーナー確定事項 (2026-11)
* Supabase は新規プロジェクト。開発中は無料プラン、本番前に Pro を判断
* Cloudflare は既存アカウント。ドメインは当面仮 (workers.dev)
* Stripe は **テストモードで開発**。手数料は仮 3.6%
* 購入時メールアドレス必須 (購入確認・再DL・期限案内)
* 画像処理は iPhone ブラウザ内。**画面を開いたまま**でよい。**失敗した写真だけ再送**を最優先
* 価格 500 / 1,000 / 2,000 円は管理画面で変更可 (settings.prices)
* 売上試算は購入率 10 / 20 / 30% を基本、40% は好調ケース

## 絶対に守る設計判断
1. **公開してよいかは `groups.online_ok` / `tv_ok` だけが正。** TypeScript に同意判定を再実装しない。
   `status='published'` は DB の CHECK が同意なしを拒否する。TV は `tv_ok`、販売ページは `online_ok`。
   未成年を含むなら保護者同意が必須。**同意が無い写真は公開しない** (アップロードは可)
2. **価格計算は `photo_calc_price()` だけ。** 画面の表示用に同じ式を書く場合も、
   サーバー (`photo_create_pending_order`) の結果が正。クライアント送信の金額は使わない
3. **二重購入は DB で止める。** `order_items.counted` の部分一意インデックス。
   決済確定は `photo_finalize_order()` のみ。重複・金額不一致は `needs_review` にして
   写真を渡さず、管理者が確認・返金する
4. **成功画面に戻っただけでは購入権限を与えない。** Webhook (署名検証 + stripe_events 冪等) で確定
5. **原本バケットに公開 URL を作らない。** 原本は Worker 経由 (注文の paid 確認後) のみ
6. QR トークンは 128bit ランダム。他グループの写真 ID を渡されても `group_id` で突合して弾く
7. 画面 → API → SQL の 3 か所を揃える (aone で何度も起きた「送っているのに中継し忘れ」)
8. DB の変更は `db/000N_*.sql` を足し、`db/_TEST_photo.sql` にテストを足してから直す

## DB のテスト
```
psql -v ON_ERROR_STOP=1 -f db/0001_initial_schema.sql   # 空の DB (anon / authenticated / service_role ロールを先に作る)
psql -v ON_ERROR_STOP=1 -f db/_TEST_photo.sql           # 最後に ALL TESTS PASSED
```
