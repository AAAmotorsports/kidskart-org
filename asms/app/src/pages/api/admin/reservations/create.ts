import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/admin/reservations/create
//
// 管理者による代理予約作成 (電話予約・店頭予約・Reserva 移行等)。
// Basic Auth (middleware) で保護済み。
//
// /api/reserve/create.ts との違い:
//   - Turnstile CAPTCHA を skip
//   - 署名が未指定なら「[代理入力] 保護者名」の typed signature を自動生成
//     (当日受付で紙同意書に本人サインを取り、事後に電子署名を差し替えることが可能)
//   - checked_safety_items が未指定なら現行 terms の全項目を自動チェック
//     (admin が受付時に本人確認する前提)
//   - referral_code のデフォルトは 'PROXY_ADMIN' (集計時の代理入力識別用)
//   - 顧客向け確認メールは通常通り送信 (お客様に記録が残る)
//
// Body: /api/reserve/create.ts と同じ。省略可能なもの:
//   - signature (省略時は自動生成)
//   - checked_safety_items (省略時は全チェック)
//   - referral_code (省略時は 'PROXY_ADMIN')
//   - turnstile_token (無視)

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const {
    slot_id,
    term_id: termIdInput,
    price_tier,
    participants,
    guardian,
    emergency,
    signature: signatureInput,
    checked_safety_items: safetyInput,
    referral_code,
  } = body ?? {};

  // --- Shallow validation ------------------------------------------------
  if (!slot_id) return json({ error: 'slot_id は必須です' }, 400);
  if (!Array.isArray(participants) || participants.length === 0) {
    return json({ error: '参加者情報が空です' }, 400);
  }
  if (!guardian?.name || !guardian?.phone || !guardian?.email) {
    return json({ error: '保護者情報が不足しています (氏名・電話・メール)' }, 400);
  }
  for (const p of participants) {
    if (!p.name || !p.kana || !p.birth_date || !p.gender || !p.height_cm) {
      return json({ error: '参加者情報に不足があります' }, 400);
    }
  }

  // --- Auto-fill defaults for admin proxy path ---------------------------
  // term_id が未指定なら現行 terms を lookup。安全項目も同時に取得。
  let termId = termIdInput;
  let safetyItems: Array<{ id: number }> = [];
  if (!termId || !Array.isArray(safetyInput)) {
    const { data: term, error: termErr } = await supabase
      .from('terms')
      .select('id, safety_items')
      .eq('is_current', true)
      .maybeSingle();
    if (termErr || !term) {
      return json({ error: '現行の利用規約が見つかりません', detail: termErr?.message }, 500);
    }
    if (!termId) termId = term.id;
    safetyItems = (term.safety_items as any) ?? [];
  }
  const checked_safety_items = Array.isArray(safetyInput)
    ? safetyInput
    : safetyItems.map((it: any) => it.id);

  // 署名: 未指定なら「[代理入力] 保護者名」の typed signature を自動生成。
  // 当日受付で紙同意書 → 電子化する場合は後日 consents レコード update で対応。
  const signature = signatureInput ?? {
    type: 'typed',
    typed_name: `[代理入力] ${guardian.name}`,
  };

  // 緊急連絡先: 未指定なら保護者情報を流用 (同一想定)
  const emergencyResolved = emergency ?? {
    name: guardian.name,
    phone: guardian.phone,
    relation: '本人',
  };

  // referral_code: 代理入力の識別子。カスタム指定があれば優先。
  const rawRef = ((typeof referral_code === 'string' ? referral_code : '') || 'PROXY_ADMIN')
    .trim()
    .toUpperCase()
    .slice(0, 60)
    .replace(/[^A-Z0-9_.-]/g, '');
  const validRef = rawRef && /^[A-Z0-9_.-]+$/.test(rawRef) ? rawRef : 'PROXY_ADMIN';

  const guardianEmail = (guardian.email ?? '').trim();

  // --- Single atomic RPC call --------------------------------------------
  // 管理者代理予約は WEB 予約締切 (開始 3 時間前) を bypass する。
  // この endpoint は middleware で Basic Auth 済み (/api/admin/*) なので、
  // ここに到達している = admin 認証済み。p_bypass_cutoff=true を hard-coded
  // で渡す (payload 側にクライアント指定の bypass_cutoff は無視する設計)。
  const { data: rpcResult, error: rpcErr } = await supabase.rpc('create_reservation_atomic', {
    payload: {
      slot_id,
      term_id: termId,
      price_tier: price_tier === 'member' ? 'member' : 'regular',
      guardian: { ...guardian, email: guardianEmail },
      emergency: emergencyResolved,
      participants,
      signature,
      checked_safety_items,
      ip_address: request.headers.get('CF-Connecting-IP') || clientAddress || '',
      user_agent: '[admin_proxy] ' + (request.headers.get('User-Agent') || ''),
    },
    p_bypass_cutoff: true,
  });

  if (rpcErr) {
    const hint = rpcErr.hint ?? '';
    const message = rpcErr.message ?? '不明なエラー';
    if (rpcErr.code === 'PGRSN') {
      const httpCode =
        hint === 'slot_not_found' ? 404 :
        hint === 'slot_not_open'  ? 409 :
        hint === 'slot_full'      ? 409 :
        hint === 'terms_not_found' ? 400 :
        hint === 'empty_participants' || hint === 'missing_field' ? 400 :
        500;
      return json({ error: message, hint }, httpCode);
    }
    return json({
      error: `予約の登録に失敗しました: ${message}`,
      detail: `${rpcErr.code ?? ''} ${rpcErr.details ?? ''} ${rpcErr.hint ?? ''}`.trim(),
    }, 500);
  }

  const result: any = rpcResult ?? {};
  if (!result.ok) {
    return json({ error: '予約作成が失敗しました', detail: JSON.stringify(result) }, 500);
  }

  // referral_code (PROXY_ADMIN 等) を保存
  if (result.reservation_id) {
    const { error: refErr } = await supabase
      .from('reservations')
      .update({ referral_code: validRef })
      .eq('id', result.reservation_id);
    if (refErr) {
      console.warn('[admin/reservations/create] failed to save referral_code:', refErr.message);
    }
  }

  // 顧客向け確認メールは /api/reserve/create から呼ぶのが理想だが、
  // 現状関数が private なので、admin 作成時は「メール送信は後日」扱いで
  // ひとまず省略。必要なら Resend Dashboard で手動送信 or admin から
  // メール送信ボタンを別途追加。
  //   → v1 では作成のみ・メール無し。ユースケース次第で追加検討。

  return json({
    ok: true,
    reservation_id: result.reservation_id,
    reservation_number: result.reservation_number,
    status: result.status,
    referral_code: validRef,
  });
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
