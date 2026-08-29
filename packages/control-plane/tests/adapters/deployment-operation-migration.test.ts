import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';

let root: string;
let repository: SqliteConfigRevisionRepository;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'configs-deployment-operation-'));
  repository = new SqliteConfigRevisionRepository(path.join(root, 'state.sqlite3'));
});

afterEach(() => {
  repository.close();
  rmSync(root, { recursive: true, force: true });
});

function database(): Database {
  const db = new Database(path.join(root, 'state.sqlite3'));
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

describe('deployment and operation migration', () => {
  test('creates strict tables with deployment foreign key and nullable reason fields', () => {
    const db = database();
    try {
      expect(db.query<{ strict: number }, []>("SELECT strict FROM pragma_table_list WHERE name = 'deployment_status'").get()?.strict).toBe(1);
      expect(db.query<{ strict: number }, []>("SELECT strict FROM pragma_table_list WHERE name = 'operation_status'").get()?.strict).toBe(1);

      db.query(
        'INSERT INTO deployment_status (deployment_id, phase, last_operation_id, reason, next_action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('dep-1', 'planned', null, null, 'prepare-plan', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      db.query(
        'INSERT INTO operation_status (operation_id, deployment_id, phase, reason, next_action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('op-1', 'dep-1', 'prepared', null, 'start-operation', '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      expect(db.query<{ deployment_id: string }, [string]>('SELECT deployment_id FROM operation_status WHERE operation_id = ?').get('op-1')?.deployment_id).toBe('dep-1');
      expect(() => db.query(
        'INSERT INTO operation_status (operation_id, deployment_id, phase, reason, next_action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('op-orphan', 'missing', 'prepared', null, 'start-operation', 'now', 'now')).toThrow();
    } finally {
      db.close();
    }
  });

  test('rejects phases outside the bounded domain', () => {
    const db = database();
    try {
      expect(() => db.query(
        'INSERT INTO deployment_status (deployment_id, phase, last_operation_id, reason, next_action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('dep-invalid', 'bogus', null, null, 'none', 'now', 'now')).toThrow();
    } finally {
      db.close();
    }
  });

  test('reruns migration safely on a second repository open', () => {
    const statePath = path.join(root, 'state.sqlite3');
    repository.close();
    repository = new SqliteConfigRevisionRepository(statePath);
    repository.close();
    repository = new SqliteConfigRevisionRepository(statePath);
    const db = database();
    try {
      expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('deployment_status', 'operation_status') ORDER BY name").all()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

});
