# A-ONE 走行写真販売 — 開発時の恒久指針

会話履歴がリセットされても、ここを起点に判断してください。
設計の全体は `DESIGN.md`、画面は `docs/SCREENS.md`、インフラ・費用は `docs/INFRA_D1.md`、DB は `app/migrations/`。

**aone (予約システム) とは別アプリ。** Supabase・Worker・R2・Stripe はすべて別。
`aone/` 配下のファイルを変更しない。`aone/app/wrangler.jsonc` の値をコピーしない。

## オーナー確定事項 (2026-11)
* **月額固定費 0 円** が目標: Cloudflare Workers + D1 + R2 (無料枠)。Supabase は使わない (旧案は db/archive-supabase)。バックアップ・セキュリティ・障害復旧は妥協しない
* Cloudflare は既存アカウント。ドメインは当面仮 (workers.dev)
* **同じ写真を何人にでも販売可**。注文・DL 権限・返金は購入者ごとに独立。全写真パック = 注文時点の公開写真すべて
* Stripe は **テストモードで開発**。手数料は仮 3.6%
* 購入時メールアドレス必須 (購入確認・再DL・期限案内)
* 画像処理は iPhone ブラウザ内。**画面を開いたまま**でよい。**失敗した写真だけ再送**を最優先
* 価格 500 / 1,000 / 2,000 円は管理画面で変更可 (settings.prices)
* 売上試算は購入率 10 / 20 / 30% を基本、40% は好調ケース

## 絶対に守る設計判断
1. **公開してよいかは `groups.online_ok` / `tv_ok` (生成列) だけが正。** TypeScript に同意判定を再実装しない。
   `status='published'` は DB の CHECK が同意なしを拒否する。TV は `tv_ok`、販売ページは `online_ok`。
   未成年を含むなら保護者同意が必須。**同意が無い写真は公開しない** (アップロードは可)
2. **価格計算は `src/lib/shop/pricing.ts` の `calcPrice()` だけ。** クライアント送信の金額は使わない
3. **同じ写真を複数人に売る。** order_items に注文をまたぐ一意制約を足さない。権限は注文ごと
4. **二重決済は 4 段で防ぐ**: 未決済注文の再利用 (`cart_hash`) / `payments.stripe_payment_intent` 一意 /
   `finalizePayment` の条件付き UPDATE / 決済済み注文への 2 本目の支払いは `duplicate_payment` で要確認 → 管理者が返金
5. **成功画面に戻っただけでは購入権限を与えない。** Webhook (署名検証) で確定。決済確定は `finalizePayment` のみ
6. **原本・プレビューのバケットに公開 URL を作らない。** 原本は Worker が注文の paid・期限を確認して返す
7. QR トークンは 128bit ランダム。他グループの写真 ID を渡されても `group_id` で突合して弾く
8. **無料枠 CPU 10ms を意識する**: 重い計算 (PBKDF2・画像処理・ZIP 圧縮) を Worker に置かない
9. D1 は 1 クエリ bind 100 個まで → 配列は `json_each(?)`。複数文の原子性は `db.batch()`
10. 画面 → API → DB の 3 か所を揃える。DB 変更は `app/migrations/000N_*.sql` を足し、`app/tests/` にテストを足す

## テスト
```
cd app && npm test        # node:sqlite 上で同じ SQL と TypeScript ロジックを検証 (20 項目)
npm run typecheck && npm run build
```

## 実装メモ (M1〜M3)
* スタッフ認証: メールリンク → `/admin/verify` (確認ボタン) → POST でセッション。`src/lib/auth.ts`。パスワード・PBKDF2 は使わない
* **referrer-policy は `same-origin`。`no-referrer` にしない** (Chromium 系は同一サイトの POST でも Origin: null を送り、CSRF 検査が壊れる)
* アップロード: ブラウザで原本(EXIF除去)/プレビュー/サムネ/CRC32/SHA-256 を作り、1 枚 = 1 リクエスト (3 画像を連結) で `/api/admin/groups/:id/photos` へ。何度送っても安全 (sha256 で重複無視)
* R2 のキーは `ph/{photoId}/{original|preview|thumb}.jpg` (団体に依存しない → 写真の移動は DB 更新だけ)
* お客様・TV の画像は Worker 経由で、都度 `online_ok` / `tv_ok` と団体の一致を確認する (`src/lib/public.ts`)
* TV は Service Worker (`public/tv-sw.js`) で画像を端末にキャッシュ。通信断でも直近の写真で継続表示
* 開発時のログインリンク: `wrangler dev` のログ (RESEND_API_KEY 未設定時はメールをコンソールに出す)
* HEIC: `accept` に heic/heif を含め、そのまま選べる。Safari は端末の標準デコーダ、非対応のブラウザは libheif-js (WASM, LGPL-3.0) を**必要なときだけ遅延読み込み**。EXIF は JPEG と HEIC (ISO-BMFF) の両方から撮影時刻を取る (`src/scripts/imaging.ts`)
* 大量アップロード: 変換は 1 枚ずつ (iPhone のメモリ対策)・送信は 3 並列・オフライン中は待機・送信済みは localStorage で記録 (`src/scripts/uploader.ts`)。並列変換に戻さない
