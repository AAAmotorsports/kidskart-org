export interface Prices { single: number; set3: number; pack: number }

/**
 * 価格計算 (唯一の正)。
 * n 枚を選ぶと、3 枚ごとに set3、余りは (余り×single) と set3 の安い方。
 * その額が pack 以上なら「全写真パック」(= 注文時点の公開写真すべて) に切り替える。
 * 例 (500/1000/2000): 1→500 2→1000 3→1000 4→1500 5→2000(パック) 6→2000(パック)
 * 他のお客様の購入状況は関係しない (同じ写真を何人にでも売る)。
 */
export function calcPrice(n: number, prices: Prices): { amount: number; pack: boolean } {
  if (!Number.isInteger(n) || n < 1) throw new Error('empty_selection');
  const cost = Math.floor(n / 3) * prices.set3 + Math.min((n % 3) * prices.single, prices.set3);
  if (prices.pack > 0 && cost >= prices.pack) return { amount: prices.pack, pack: true };
  return { amount: cost, pack: false };
}
