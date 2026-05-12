# kidskart.org — Vercel 移行手順

## このフォルダの中身

```
kidskart/
├── index.html              # トップページ（旧WPから移行する新ランディング）
├── stories/                # 旧ブログのアーカイブ（静的化済み・84記事）
│   ├── index.html          # アーカイブ一覧（年別グリッド）
│   ├── 2013/ ... 2019/     # 年別ディレクトリ
│   └── ...
├── vercel.json             # Vercel 静的配信設定
├── DEPLOY.md               # このファイル
└── _backup/
    ├── wordpress-export.xml          # 元のWPエクスポート（バックアップ）
    └── wordpress-export.cleaned.xml  # 制御文字除去版
```

`_backup/` は **公開不要**。Vercel デプロイ前に削除するか、`.vercelignore` で除外してください。

---

## 重要：このまま公開する前にやること

### 必須: WordPress を `wp.kidskart.org` サブドメインで延命

`stories/` 配下の記事は **画像を `https://wp.kidskart.org/wp-content/uploads/...` 参照**しています。
これは「WordPress を別サブドメインに残して画像配信用に使う」前提です。

**この設定をしないと、旧記事の画像はすべて 404 になります。**

手順:

1. **Xserver 側**: `wp.kidskart.org` をサブドメインとして追加（Xserver 管理画面 → サブドメイン設定）
2. **WordPress の `wp-config.php` または管理画面 → 設定 → 一般**で:
   - WordPress アドレス (URL): `https://wp.kidskart.org`
   - サイトアドレス (URL): `https://wp.kidskart.org`
3. **ムームードメイン**: DNS で `wp` の CNAME を Xserver のサーバー名に向ける
   - 例: `wp.kidskart.org. CNAME sv1234.xserver.jp.`（Xserver の実サーバー名は管理画面で確認）
4. 反映後、`https://wp.kidskart.org/wp-content/uploads/2016/04/IMG_0019-300x225.jpg` 等が開けることを確認

> 💡 もし「WordPress を削除する」方針に切り替えたい場合は、後述の「画像を破棄する場合」を参照。

---

## ステップ1: GitHub リポジトリ作成

このフォルダを単独リポジトリにして push します。

```bash
# Macで:
cd /path/to/local/kidskart
rm -rf _backup            # バックアップは公開しない
git init
git add .
git commit -m "Initial: migrate kidskart.org to Vercel with stories archive"

# GitHub で kidskart-org という新規リポジトリを作成（Web UI から）
git remote add origin git@github.com:aaamotorsports/kidskart-org.git
git branch -M main
git push -u origin main
```

`_backup/` の中身は Mac のローカルだけに残しておく（万一の復旧用、半年ほど）。

---

## ステップ2: Vercel デプロイ

1. Vercel ダッシュボード → **New Project**
2. **Import Git Repository** で `aaamotorsports/kidskart-org` を選択
3. Framework Preset: **Other** （静的HTMLなので何も選ばなくてOK）
4. Root Directory: `.`（デフォルト）
5. **Deploy** をクリック
6. `xxx.vercel.app` の仮URLが発行されるので、ブラウザで開いて以下を確認:
   - [ ] トップページが表示される
   - [ ] ナビ「思い出ブログ」リンク → `/stories/` が開く
   - [ ] `/stories/` から任意の記事を開くと本文が表示される（画像は wp.kidskart.org 設定後に表示される想定）
   - [ ] 「まずは1回だけ体験してみる」ボタン → Reserva (`reserva.be/kidskart/reserve`) が開く
   - [ ] Main Sponsor バナー（福岡トヨペット）が表示される
   - [ ] 4ステップファネル（体験 → リピート → チャレンジ → AAAアカデミー）が見える

---

## ステップ3: カスタムドメイン設定（kidskart.org）

1. Vercel プロジェクト → **Settings → Domains**
2. `kidskart.org` を追加
3. Vercel が表示する DNS 設定値を控える（A レコード or CNAME）

通常:
- `kidskart.org` (apex) → A レコード: `76.76.21.21`（Vercel指定の値を確認）
- `www.kidskart.org` → CNAME: `cname.vercel-dns.com`

---

## ステップ4: ムームードメインで DNS 切替

順番が大事です。

1. **先に `wp` サブドメインを設定**（ステップ0で wp.kidskart.org を Xserver に向けたことを確認）
2. ムームー DNS で:
   - `@`（apex）の A レコードを Xserver → Vercel の IP に変更
   - `www` の CNAME を Vercel に向ける
   - `wp` の CNAME / A レコードを Xserver に向ける（**ここがポイント：画像配信用**）
   - **MX レコード（メール用）**: 既存のまま維持
3. DNS 反映待ち（数分〜数時間）

確認:
```bash
dig kidskart.org +short          # Vercel のIPが返るはず
dig wp.kidskart.org +short       # Xserver のIPが返るはず
dig www.kidskart.org +short      # Vercelの値が返るはず
```

---

## ステップ5: 切替後の確認

DNS反映後（最低30分待つ）:

- [ ] https://kidskart.org/ で新サイトが開く
- [ ] https://kidskart.org/stories/ で記事一覧が開く
- [ ] 記事内の画像が表示される（= wp.kidskart.org が正しく動いている）
- [ ] Reserva の予約フローが実際に動く（テスト予約してみる）
- [ ] スマホでも表示崩れがない
- [ ] LINE @kidskart / Instagram @fukuoka_kidskart からの導線確認

---

## ステップ6: 後片付け（最低1週間は触らない）

DNS 切替後 **最低1週間** は Xserver の WordPress 本体は削除しない。
万一のロールバック用。

問題がなさそうなら、1〜3ヶ月後に:
- WordPress の **記事と設定** は削除して構わない
- **`wp-content/uploads/` ディレクトリ（画像）は残す** — `wp.kidskart.org` が動き続けるために必要

つまり最終的な状態:
```
kidskart.org           → Vercel（新サイト）
wp.kidskart.org        → Xserver（画像配信のみ。WP本体は最小構成 or 静的化）
```

`wp.kidskart.org` を完全に静的化したくなったら、`wget --mirror` で `wp-content/uploads/` だけ吸い出して、Vercel 側の `/stories/img/` などに移植する手もあります。その場合は `stories/` 配下の全 `.html` で `https://wp.kidskart.org/wp-content/uploads/` を `/img/uploads/` などに sed 一括置換。

---

## 画像を破棄する場合（WP延命しない方針に切り替えたとき）

`stories/` 配下の全 HTML で `<img>` タグごと削除する場合:

```bash
cd /path/to/kidskart/stories
find . -name '*.html' -exec sed -i '' 's|<p[^>]*><img[^>]*></p>||g; s|<img[^>]*>||g' {} \;
```

または、画像枠だけ残して「画像は移行されていません」のプレースホルダにする等の対応も可能。

---

## 緊急ロールバック

ムームードメインの DNS を Xserver の値に戻すだけ。
（旧 WP 本体を消していなければ即復旧）

---

## 既知の注意点

1. **記事内の絵文字 GIF**: 旧 typepad-emoji-for-tinymce プラグインの装飾絵文字（壊れていた）は生成時に除去済み
2. **ameba.jp のキャラクター GIF**: 同上、除去済み
3. **記事内リンク**: 同じドメインの過去記事リンクは `wp.kidskart.org/...` にリライト済み（WP 延命前提なら動く）
4. **「写真館」系投稿**: 写真ダンプ目的の投稿（タイトルに「写真館」を含む）は移行対象から除外。166本中84本が静的化済み
5. **元のWPエクスポート**: `_backup/wordpress-export.xml` に保全。`.vercelignore` で配信から除外推奨

---

## .vercelignore 推奨設定

ルートに `.vercelignore` を作成:

```
_backup/
*.xml
DEPLOY.md
README.md
```
