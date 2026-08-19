// English translations (target audience: short-stay tourists)
// -----------------------------------------------------------------
// Tone: simple, direct, visual. Avoid complex jargon.
// -----------------------------------------------------------------

export const en = {
  common: {
    signInStatus: 'Signed in as: ',
    signOut: 'Sign out',
    back: 'Back',
    next: 'Next',
    submit: 'Submit',
    cancel: 'Cancel',
    close: 'Close',
    yen: '¥',
    minutes: 'min',
    seats: 'seats',
    remaining: '',
    slots: 'slots',
    full: 'Full',
    fewLeft: 'Few left',
    startsAt: 'Starts at {time}',
    langLabel: '🇬🇧 English',
    switchToEn: '日本語',
  },

  landing: {
    title: 'Book Now',
    subtitle: 'Fukuoka Kids Kart Academy · A-One Circuit',
    intro: {
      summary: 'First time here?',
      summaryDetail: '(age, what to bring, dress code, cancellation policy)',
    },
    courses: {
      heading: 'Course List',
      firstTimeBadge: '⭐️ Recommended for first-timers',
      active: '✓ Now viewing',
      memberNote: '', // 英語版では member 割引を出さないので注記も省略
    },
    calendar: {
      heading: 'Choose a Date',
      filtering: '🔍 Filtering by {name}',
      prevMonth: '← Prev',
      nextMonth: 'Next →',
      tapHint: 'Tap a green day → time slots will appear below',
      dayCount: '{count} slot(s)',
      noSlotsInMonth: 'No sessions in this month.',
      noSlots: 'No upcoming sessions available right now.',
    },
    slotList: {
      seatsRemaining: '{n} seat(s) left',
    },
  },

  wizard: {
    stepOf: 'Step {n} / {total}',
    priceTier: {
      heading: 'Price Plan',
      regular: 'Regular',
      // 英語版では member 選択自体を UI に出さないので翻訳不要
    },
  },

  complete: {
    thankyou: 'Thank you for your booking!',
    reservationNumber: 'Reservation number',
  },

  signin: {
    title: 'Sign in',
  },
} as const;

// 注: en が ja とキーずれしていても runtime は key を文字列で辿って
// フォールバック (i18n.ts) するので、ビルドは通る。将来的に厳密な
// 型チェックが欲しければ satisfies typeof ja を追加する。
