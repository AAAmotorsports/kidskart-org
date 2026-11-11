// D1 のうち使う部分だけの型。テストでは node:sqlite のアダプタを渡す。
export interface Stmt {
  bind(...v: unknown[]): Stmt;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface Db {
  prepare(sql: string): Stmt;
  /** 原子的 (全部成功 or 全部取り消し) */
  batch(stmts: Stmt[]): Promise<{ meta: { changes: number } }[]>;
}

/** エラーは code で判別する (画面側の文言に対応づける) */
export type ShopErrorCode =
  | 'group_not_available' | 'photo_not_available' | 'already_owned'
  | 'email_required' | 'empty_selection' | 'order_not_found' | 'payment_not_found';

export class ShopError extends Error {
  code: ShopErrorCode;
  constructor(code: ShopErrorCode) {
    super(code);
    this.code = code;
  }
}
