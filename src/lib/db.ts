export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function one<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...binds).first<T>();
}

export async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...binds).all<T>();
  return result.results;
}
