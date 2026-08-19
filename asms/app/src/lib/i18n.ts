// -----------------------------------------------------------------
// i18n: 予約フローの多言語対応 (JA/EN 2 ロケール)
//
// 判定優先順位:
//   1. Cookie `asms:locale=xx` (ユーザーが言語トグルで明示選択)
//   2. Accept-Language ヘッダ (ブラウザ設定、en* なら英語)
//   3. デフォルト: ja
//
// 使用例 (server-side):
//   const locale = getLocaleFromRequest(Astro.request);
//   const label = t(locale, 'reserve.title');
//
// 翻訳キーは locales/{ja,en}.ts に階層で定義。
// 存在しないキーは key 自体を返す (フォールバック)。
// -----------------------------------------------------------------

import { ja } from '@/locales/ja';
import { en } from '@/locales/en';

const DICTS = { ja, en } as const;
export type Locale = keyof typeof DICTS;

export const LOCALE_COOKIE = 'asms:locale';
export const LOCALES: Locale[] = ['ja', 'en'];
export const LOCALE_LABELS: Record<Locale, string> = {
  ja: '🇯🇵 日本語',
  en: '🇬🇧 English',
};

/**
 * Request から現在のロケールを判定する。
 * Cookie > Accept-Language > default(ja) の順で試行。
 */
export function getLocaleFromRequest(request: Request): Locale {
  // 1. Cookie 優先 (ユーザー明示選択)
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${escapeRegex(LOCALE_COOKIE)}=([a-z]{2})`),
  );
  if (match) {
    const v = match[1] as Locale;
    if (LOCALES.includes(v)) return v;
  }
  // 2. Accept-Language (en, en-US 等)
  const al = (request.headers.get('accept-language') || '').toLowerCase();
  const first = al.split(',')[0]?.trim() ?? '';
  if (first.startsWith('en')) return 'en';
  // 3. デフォルト
  return 'ja';
}

/**
 * 翻訳キー引き。ドット区切りで階層アクセス。
 *   t('en', 'reserve.title') → "Book Now"
 * パラメータ補間 {name} → 値。
 */
export function t(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const dict = DICTS[locale] ?? DICTS.ja;
  const value = key.split('.').reduce<unknown>(
    (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
    dict,
  );
  if (typeof value !== 'string') {
    // フォールバック: JA を試す
    if (locale !== 'ja') {
      const jaValue = key.split('.').reduce<unknown>(
        (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
        DICTS.ja,
      );
      if (typeof jaValue === 'string') return interp(jaValue, params);
    }
    return key; // キー自体を返す (開発中の気付き用)
  }
  return interp(value, params);
}

function interp(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ロケール切替リンク用の URL を作る。
 * 現在のパスとクエリを保持したまま、Cookie 変更後にリロードすることで
 * 同じ画面を切替後の言語で再描画させる。
 */
export function localeSwitchScript(): string {
  return `
    document.querySelectorAll('[data-locale-switch]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const target = el.getAttribute('data-locale-switch');
        if (!target) return;
        const oneYear = 60 * 60 * 24 * 365;
        document.cookie = '${LOCALE_COOKIE}=' + target + '; path=/; max-age=' + oneYear + '; SameSite=Lax';
        location.reload();
      });
    });
  `;
}
