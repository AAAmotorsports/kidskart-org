// 気象庁の予報 JSON を読む (API キー不要・公開エンドポイント)。
//
// 仕様 8: 管理画面に当日の天気予報を「営業判断の参考情報」として出す。
// システムが自動で営業中止にはしない — 最終判断は A-ONE 側。

export interface ForecastToday {
  areaName: string;
  publishingOffice: string;
  reportDatetime: string;
  weather: string;          // 例: 「くもり 昼過ぎ から 時々 雨」
  wind?: string;
  /** 時間帯別の降水確率 (0-6,6-12,12-18,18-24 時) */
  pops: Array<{ label: string; pop: string }>;
  tempMax?: string;
  tempMin?: string;
}

const POP_LABELS = ['00-06時', '06-12時', '12-18時', '18-24時'];

/**
 * 当日の予報を返す。取得に失敗したら null (画面側は「取得できません」と出す)。
 * areaCode は気象庁の府県予報区コード (福岡県 = 400000)。
 */
export async function fetchTodayForecast(areaCode = '400000'): Promise<ForecastToday | null> {
  const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${areaCode}.json`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'aone-booking/1.0 (+https://kidskart.org)' },
      // Cloudflare Workers のキャッシュに 30 分乗せる
      cf: { cacheTtl: 1800, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    const data: any = await res.json();

    const near = data?.[0];
    if (!near) return null;

    const weatherSeries = near.timeSeries?.[0];
    const popSeries = near.timeSeries?.[1];
    const tempSeries = near.timeSeries?.[2];

    const area = weatherSeries?.areas?.[0];
    const pops: Array<{ label: string; pop: string }> = [];
    const popArea = popSeries?.areas?.[0];
    if (popArea?.pops) {
      popArea.pops.slice(0, 4).forEach((p: string, i: number) => {
        pops.push({ label: POP_LABELS[i] ?? `${i}`, pop: p });
      });
    }

    const temps: string[] = tempSeries?.areas?.[0]?.temps ?? [];

    return {
      areaName: area?.area?.name ?? '',
      publishingOffice: near.publishingOffice ?? '気象庁',
      reportDatetime: near.reportDatetime ?? '',
      weather: (area?.weathers?.[0] ?? '').replace(/　+/g, ' ').trim(),
      wind: area?.winds?.[0],
      pops,
      tempMin: temps[0],
      tempMax: temps[1],
    };
  } catch (e) {
    console.warn('[weather] 気象庁 API の取得に失敗:', e);
    return null;
  }
}
