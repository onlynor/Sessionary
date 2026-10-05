import type { DatabaseSync as DB } from 'node:sqlite'

// Loaded via getBuiltinModule: bundlers rewrite the `node:sqlite` specifier to bare `sqlite`, which doesn't resolve.
export const DatabaseSync = (process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')).DatabaseSync
export type DatabaseSync = DB
