-- =============================================================================
-- 公開表示の「姓のみ」が法人名・カタカナ姓で壊れていたのを直す
-- =============================================================================
-- 2026-08 実運用で発覚:
--
--   (株)ふーぷーパートナーズ → 「(株 様」
--   株)フーブパートナーズ     → 「株) 様」
--   エンドウ                  → 「エン 様」
--   ナカゾノ                  → 「ナカ 様」
--
-- 「空白が無ければ先頭 2 文字が姓」という決めうちが原因。日本人の姓名には
-- 効くが、法人名・団体名・カタカナだけの姓には効かない。
--
-- 貸切は「団体名が入るので略さない」と決めて逃げていたが、RP にも法人名や
-- チーム名で入る。種別ではなく **名前そのものを見て** 判断する。
--
-- 直したあとの規則 (family モード):
--   1. 法人・団体らしければ略さない    (株)ふーぷーパートナーズ / A-ONE Racing
--   2. 空白があれば先頭トークン        山田 太郎 → 山田
--   3. 漢字を含まなければ略さない      エンドウ / ナカゾノ (姓だけ入れた形)
--   4. 3 文字以下なら略さない          今井 / 佐々木
--   5. それ以外は先頭 2 文字           山田太郎 → 山田
--
-- full / hidden の挙動は変えていない。
-- =============================================================================

-- 法人・団体らしい名前か。ここに載っていない書き方は「個人名」として扱う
-- (略しすぎるより、略さないほうが実害が小さい)。
create or replace function aone_looks_like_org(p_name text) returns boolean
language sql immutable as $$
  select case
    when coalesce(trim(p_name), '') = '' then false
    -- (株) 【 ㈱ など記号で始まるものは、まず個人名ではない
    when trim(p_name) ~ '^[[:punct:]（）【】㈱㈲]' then true
    -- ラテン文字を含む (A-ONE Racing / SMG FUKUOKA)
    when p_name ~ '[A-Za-zＡ-Ｚａ-ｚ]' then true
    -- 法人格・組織を示す語
    when p_name ~ ('株式会社|有限会社|合同会社|㈱|㈲|株\)|株）|\(株|（株|有\)|\(有|'
                || '財団|社団|組合|大学|高校|中学|学園|学院|工科|工業|自動車|商事|'
                || 'レーシング|レース|チーム|クラブ|アカデミー|サービス|工房|商会') then true
    else false
  end;
$$;

comment on function aone_looks_like_org(text) is
  '法人・団体らしい名前か。公開表示で姓のみに略してよいかの判断に使う';

create or replace function aone_public_name(p_name text, p_mode text)
returns text
language sql immutable as $$
  with n as (select coalesce(aone_strip_honorific(p_name), trim(coalesce(p_name, ''))) as v)
  select case
    when p_mode = 'hidden' then null
    when (select v from n) = '' then null
    when p_mode = 'full' then (select v from n) || ' 様'

    -- 1. 法人・団体は略すと意味が通らなくなる。空白の判定より先に見る
    --    (「A-ONE Racing」を空白で切ると「A-ONE」になってしまう)
    when aone_looks_like_org((select v from n)) then (select v from n) || ' 様'

    -- 2. 空白があれば先頭を姓とみなす (山田 太郎 → 山田)
    when position(' ' in (select v from n)) > 0 or position('　' in (select v from n)) > 0
      then split_part(replace((select v from n), '　', ' '), ' ', 1) || ' 様'

    -- 3. 漢字を含まない = 姓だけを入れた形 (エンドウ / なかぞの) なのでそのまま
    when (select v from n) !~ '[一-龥々]' then (select v from n) || ' 様'

    -- 4. 短いものはそのまま (今井 / 佐々木)
    when length((select v from n)) <= 3 then (select v from n) || ' 様'

    -- 5. 漢字の姓名がつながっている (山田太郎) → 先頭 2 文字
    else left((select v from n), 2) || ' 様'
  end;
$$;

grant execute on function aone_looks_like_org(text) to anon, authenticated, service_role;
