# ASMS — AAA Safety Management System

福岡キッズカートアカデミー の予約・安全管理システム。Reserva 置き換え + 事故防止のための安全記録基盤。

## ステータス

**Phase 1 実装開始**（2026-08 -〜） · [計画書 v0.2.2](https://claude.ai/code/artifact/e21e8b91-d167-4d6d-ada8-c32804a645c1) · [プロトタイプ v0.3](https://claude.ai/code/artifact/0bbb5bd7-af03-439f-bf43-d9c962a3d735)

## アーキテクチャ

```
[お客様 iPhone]           [スタッフ iPhone / PC]
        |                          |
        v                          v
   kidskart.org/reserve      admin.kidskart.org (or /admin)
        |__________________________|
                    |
                    v
          Cloudflare Pages + Workers
                    |
        +-----------+-----------+
        v                       v
      Supabase                Resend
    (Postgres + Auth)        (Email)
```

- **Frontend**: Astro (SSR) → Cloudflare Pages
- **API**: Cloudflare Workers (Astro API routes)
- **DB**: Supabase (Postgres 15+ / Row Level Security)
- **File**: Cloudflare R2 (署名画像・PDF)
- **Mail**: Resend
- **CAPTCHA**: Cloudflare Turnstile
- **Auth**: Supabase Auth (staff のみ、TOTP 2FA 必須)

## セットアップ手順

### あなた側で必要な準備

以下 3 サービスの無料アカウント作成 & 招待:

**1. Cloudflare** — https://dash.cloudflare.com/sign-up
- 個人メールで OK
- 無料プラン
- ドメイン `kidskart.org` を追加（既存 DNS は Xserver のままで、Cloudflare は Pages のみ利用）

**2. Supabase** — https://supabase.com/dashboard/sign-up
- GitHub 連携推奨
- 無料プラン
- 新規プロジェクト作成: `kidskart-asms` (Region: `Tokyo`)

**3. Resend** — https://resend.com/signup
- 無料プラン (月 3,000 通)
- Domain: `kidskart.org` を追加 → DKIM レコードを Xserver に追加（後で私が案内）

### 実装者側（Claude Code）で行う作業

1. Supabase の SQL Editor で `db/0001_initial_schema.sql` を実行 → 15 テーブル + 全 RLS ポリシーが作成される
2. Astro プロジェクトを `asms/app/` にセットアップ
3. `.env.local` を作成（[.env.example](./.env.example) 参照）
4. Cloudflare Pages でこの subfolder を deploy target に設定

### スタッフの初期登録

現在の予定スタッフ:

| 名前 | 権限 |
|---|---|
| マスター | owner |
| スタッフ 1 | owner (Phase 1 は全員 owner) |
| スタッフ 2 | owner |
| スタッフ 3 | owner |

**登録手順**（DB スキーマ流し込み後）:

1. Supabase Dashboard → Authentication → Users → 各スタッフを "Add user" で招待
2. 各スタッフがメール経由でパスワード設定
3. Supabase SQL Editor で以下を実行（メールアドレスは実際のものに）:

```sql
INSERT INTO staff (auth_user_id, email, name, role) VALUES
  ((SELECT id FROM auth.users WHERE email='master@example.com'), 'master@example.com', 'マスター', 'owner'),
  ((SELECT id FROM auth.users WHERE email='staff1@example.com'), 'staff1@example.com', 'スタッフ 1', 'owner'),
  ((SELECT id FROM auth.users WHERE email='staff2@example.com'), 'staff2@example.com', 'スタッフ 2', 'owner'),
  ((SELECT id FROM auth.users WHERE email='staff3@example.com'), 'staff3@example.com', 'スタッフ 3', 'owner');
```

Phase 2 で管理画面から追加/権限変更ができるようになります。

## ファイル構成

```
asms/
├── README.md                    ← このファイル
├── .env.example                 ← 環境変数の雛形
├── db/
│   └── 0001_initial_schema.sql  ← DB スキーマ v1.0
├── docs/
│   └── (今後追加)
└── app/                         ← 実装本体（今後追加）
    ├── src/
    ├── package.json
    └── astro.config.mjs
```

## Phase 1 実装優先順

1. ✅ DB スキーマ設計（0001_initial_schema.sql）
2. ⏳ Astro プロジェクトセットアップ + 開発サーバー起動
3. ⏳ 予約フロー UI (9 ステップ)
4. ⏳ 空き枠計算 API (二重予約防止ロック含む)
5. ⏳ 電子署名 + 同意履歴保存
6. ⏳ スタッフログイン (2FA)
7. ⏳ 管理画面 (ダッシュボード / 予約一覧 / 顧客詳細 / スケジュール)
8. ⏳ 予約完了メール
9. ⏳ PDF 出力
10. ⏳ Reserva 並行運用 → 本番切替 → Reserva 解約

## Phase 2 予定

- ヒヤリ・ハット報告
- 天候判断記録
- SMS 通知
- 顧客キャンセル URL

## Phase 3 予定

- 車両点検・コース点検
- 事故報告
- 安全改善履歴
- スタッフ教育
- マニュアル管理
