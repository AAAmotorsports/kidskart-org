// 日本語翻訳 (default locale)
// -----------------------------------------------------------------
// キー階層: page.section.item
// 補間: {name} で埋め込み
// -----------------------------------------------------------------

export const ja = {
  common: {
    signInStatus: 'サインイン中: ',
    signOut: 'サインアウト',
    back: '戻る',
    next: '次へ',
    submit: '送信',
    cancel: 'キャンセル',
    close: '閉じる',
    yen: '¥',
    minutes: '分',
    seats: '席',
    remaining: '残',
    slots: '枠',
    full: '満席',
    fewLeft: '残りわずか',
    startsAt: '{time} 開始',
    langLabel: '🇯🇵 日本語',
    switchToEn: 'English',
  },

  landing: {
    title: '予約',
    subtitle: '福岡キッズカートアカデミー · エーワンサーキット',
    intro: {
      summary: '初めての方へ',
      summaryDetail: '（対象年齢・持ち物・服装・キャンセル規定）',
    },
    courses: {
      heading: 'コース一覧',
      firstTimeBadge: '⭐️ 初めての方はこちら',
      active: '✓ 表示中',
      memberNote: '💡 **トヨピー会員価格**は当日受付での会員登録でも適用可能。LINE 友達とは別プログラムです。',
    },
    calendar: {
      heading: '開催予定日を選ぶ',
      filtering: '🔍 {name} で絞り込み中',
      prevMonth: '← {m}月',
      nextMonth: '{m}月 →',
      tapHint: '緑の日をタップ → 下に時間帯一覧が表示されます',
      dayCount: '{count}枠',
      noSlotsInMonth: 'この月に該当する予定はありません。',
      noSlots: '現在、公開中の予定はありません。',
    },
    slotList: {
      seatsRemaining: '残 {n} 席',
    },
  },

  wizard: {
    stepOf: 'ステップ {n} / {total}',
    priceTier: {
      heading: '料金プランを選択',
      regular: '一般',
      member: 'トヨピー会員',
    },
    // (以下、他のステップは後続 PR で追加)
  },

  complete: {
    thankyou: 'ご予約ありがとうございました',
    reservationNumber: '予約番号',
  },

  signin: {
    title: 'サインイン',
    // (後続で拡充)
  },
} as const;
