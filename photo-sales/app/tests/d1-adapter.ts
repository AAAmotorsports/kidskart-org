// node:sqlite を D1 の形 (prepare/bind/run/all/first/batch) に見せる。テスト専用。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { Db, Stmt } from '../src/lib/shop/db.ts';

export function openTestDb(): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');                     // D1 は常に有効
  raw.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const mk = (sql: string, params: unknown[] = []): Stmt => ({
    bind: (...v) => mk(sql, v),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...(params as any[])).changes) } }),
    all: async <T,>() => ({ results: raw.prepare(sql).all(...(params as any[])) as T[] }),
    first: async <T,>() => ((raw.prepare(sql).get(...(params as any[])) as T | undefined) ?? null),
  });
  const db: Db = {
    prepare: (sql) => mk(sql),
    batch: async (stmts) => {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
  return { db, raw };
}
