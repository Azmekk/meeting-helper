// SQLite through @tauri-apps/plugin-sql (`sqlite:meeting-helper.db`). Everything
// the app uses goes through this file, as `import * as db from './db'`.
//
//   connection.ts  the connection, initDb, change tracking
//   migrations.ts  the schema
//   rows.ts        database rows and how they map to the app's types
//   helpers.ts     small shared helpers
//   the rest       queries, one file per area
export { initDb } from './connection';
export * from './meetings';
export * from './folders';
export * from './transcripts';
export * from './search';
export * from './aiDocs';
export * from './chat';
export * from './tasks';
export * from './extraction';
export * from './bundles';
export * from './backup';
export type { Segment } from '../types';
