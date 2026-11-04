import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { verifySameOrigin } from '@lib/adminAuth';

export const prerender = false;

// POST /api/admin/phone-hold-create
//
// 電話予約の一時ホールド作成。
//   電話で「名前・人数・会員 or 一般・電話番号」だけ受けて席を確保する。
//   詳細 (子供氏名・生年月日・住所・緊急連絡先・署名・同意) は当日受付で
//   iPad に本人記入してもらう → 別 API (phone-hold-complete) で予約更新。
//
// 席確保のため participant 行を人数分だけ placeholder 名で作成する。
// 既存の create_reservation_atomic RPC を reuse し、placeholder データで
// 呼ぶ。作成後に is_phone_hold = TRUE に更新 (RPC は flag を知らないため)。
//
// Body:
//   {
//     slot_id: uuid,
//     guardian: { name: string, phone: string },
//     participant_count: number (1..3),
//     price_tier: 'member' | 'regular'
//   }
//
// Response:
//   { ok: true, reservation_id, reservation_number }

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const originErr = verifySameOrigin(request);
  if (originErr) return json({ error: `cross-origin blocked: ${originErr}` }, 403);

  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const slotId: string = body?.slot_id ?? '';
  const guardianName: string = (body?.guardian?.name ?? '').trim();
  const guardianPhone: string = (body?.guardian?.phone ?? '').trim();
  const participantCount: number = parseInt(String(body?.participant_count ?? 0), 10);
  const priceTier: 'member' | 'regular' = body?.price_tier === 'member' ? 'member' : 'regular';

  if (!slotId) return json({ error: 'slot_id は必須です' }, 400);
  if (!guardianName) return json({ error: 'お客様の氏名は必須です' }, 400);
  if (!guardianPhone) return json({ error: '電話番号は必須です' }, 400);
  if (!Number.isFinite(participantCount) || participantCount < 1 || participantCount > 10) {
    return json({ error: '参加人数は 1 以上 10 以下で指定してください' }, 400);
  }

  // 現行の terms (利用規約) を取得 (create_reservation_atomic が term_id 必須)
  // カラムは `is_current` (他の endpoint と揃える。`is_active` ではない)
  const { data: term, error: termErr } = await supabase
    .from('terms')
    .select('id, safety_items')
    .eq('is_current', true)
    .maybeSingle();
  if (termErr || !term) {
    return json({ error: '現行の利用規約が見つかりません', detail: termErr?.message }, 500);
  }
  const safetyItems: Array<{ id: number }> = (term as any).safety_items ?? [];
  const checkedSafetyItems = safetyItems.map((it) => it.id); // 電話予約では全てチェック扱い (admin が受けた)

  // Placeholder 参加者データ。
  //   iPad 完成時に全て上書きされる。capacity 制約と型制約を満たす最小値のみ。
  //   kana は 1 文字必須 (schema NOT NULL) なので「電」を入れておく。
  const participants = Array.from({ length: participantCount }, (_, i) => ({
    name: `電話予約#${i + 1}`,
    kana: `デンワヨヤク${i + 1}`,
    birth_date: '2020-01-01', // 置換される
    gender: 'other' as const,
    height_cm: 100,            // 最小値、置換される
    photo_consent: 'allow' as const,
    kart_experience_note: '[電話予約・詳細は当日受付で記入]',
  }));

  const placeholderToken = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const guardianPlaceholder = {
    name: guardianName,
    kana: '（電話予約）',
    phone: guardianPhone,
    // walk-in 等と同じ @noemail.local パターン。cron メール系は全て skip。
    email: `phone-hold-${placeholderToken}@noemail.local`,
    postal_code: '',
    address: '',
  };

  const emergencyPlaceholder = {
    name: guardianName,
    phone: guardianPhone,
    relation: '本人',
  };

  const signature = {
    type: 'typed' as const,
    typed_name: `[電話予約] ${guardianName}`,
  };

  // create_reservation_atomic RPC を reuse (walk-in / proxy と同じパターン)。
  // 電話予約は Web 予約締切 (開始 3 時間前) を bypass できる (admin 代理)。
  const { data: rpcResult, error: rpcErr } = await supabase.rpc('create_reservation_atomic', {
    payload: {
      slot_id: slotId,
      term_id: term.id,
      price_tier: priceTier,
      guardian: guardianPlaceholder,
      emergency: emergencyPlaceholder,
      participants,
      signature,
      checked_safety_items: checkedSafetyItems,
      ip_address: request.headers.get('CF-Connecting-IP') || clientAddress || '',
      user_agent: '[phone_hold] ' + (request.headers.get('User-Agent') || ''),
    },
    p_bypass_cutoff: true,
  });

  if (rpcErr) {
    const hint = (rpcErr as any).hint ?? '';
    const message = rpcErr.message ?? '不明なエラー';
    if ((rpcErr as any).code === 'PGRSN') {
      const httpCode =
        hint === 'slot_not_found' ? 404 :
        hint === 'slot_not_open'  ? 409 :
        hint === 'slot_full'      ? 409 :
        hint === 'terms_not_found' ? 400 : 500;
      return json({ error: message, hint }, httpCode);
    }
    return json({
      error: `電話予約の登録に失敗しました: ${message}`,
      detail: `${(rpcErr as any).code ?? ''} ${(rpcErr as any).details ?? ''} ${hint}`.trim(),
    }, 500);
  }

  const result: any = rpcResult ?? {};
  if (!result.ok) {
    return json({ error: '電話予約の作成が失敗しました', detail: JSON.stringify(result) }, 500);
  }

  // referral_code と is_phone_hold を同時更新 (集計での識別 + 電話予約フラグ)
  const { error: updErr } = await supabase
    .from('reservations')
    .update({ referral_code: 'PHONE_HOLD', is_phone_hold: true })
    .eq('id', result.reservation_id);
  if (updErr) {
    console.warn('[phone-hold-create] failed to mark is_phone_hold:', updErr.message);
    // 作成自体は成功しているので致命ではないが、電話予約バッジが付かない
    // 問題あり。レスポンスで warning を返して admin に目視確認を促す。
    return json({
      ok: true,
      warning: `予約は作成されましたが、電話予約フラグの更新に失敗しました: ${updErr.message}`,
      reservation_id: result.reservation_id,
      reservation_number: result.reservation_number,
    });
  }

  return json({
    ok: true,
    reservation_id: result.reservation_id,
    reservation_number: result.reservation_number,
  });
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
