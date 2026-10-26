// Типы пакета pg не ставим: в db.ts описано ровно то, чем пользуемся
declare module 'pg' {
  const pg: unknown;
  export default pg;
}
