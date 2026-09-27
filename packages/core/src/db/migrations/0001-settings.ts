import type { Migration } from '../types';

export const MIGRATION_0001_SETTINGS: Migration = {
  version: 1,
  name: 'settings',
  sql: `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
};