import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson } from '../../scripts/lib/contract.mjs';
import { validateGoalSession } from './domain.mjs';
import { assertStableStateRoot, digestCanonical } from './values.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const META_BYTES = Buffer.from('{"schema_version":1}\n', 'utf8');

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw storeError('CLOCK_INVALID', 'store clock returned an invalid timestamp');
  return date.toISOString();
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
    throw storeError('STATE_ROOT_INVALID', 'controller state directories must be real directories');
  }
  chmodSync(path, 0o700);
}

function ensurePrivateFile(path, bytes) {
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!readFileSync(path).equals(bytes)) {
      throw storeError('STATE_INTEGRITY_FAILURE', `${path} does not match the controller metadata`);
    }
  }
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw storeError('STATE_INTEGRITY_FAILURE', `${path} must be a regular file`);
  }
  chmodSync(path, 0o600);
}

function canonicalState(state) {
  return canonicalJson(state);
}

function eventDigest(event) {
  return digestCanonical(event);
}

function verifyRegularPrivateFile(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw storeError('STATE_INTEGRITY_FAILURE', `${path} must be a regular file`);
  }
}

function publishBlob({ blobsRoot, kind, bytes }) {
  if (typeof kind !== 'string' || kind.trim().length === 0) {
    throw storeError('BLOB_KIND_INVALID', 'blob kind must be a non-empty string');
  }
  const content = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
  const hash = sha256(content);
  const shard = join(blobsRoot, hash.slice(0, 2));
  ensurePrivateDirectory(shard);
  const destination = join(shard, hash);
  if (existsSync(destination)) {
    verifyRegularPrivateFile(destination);
    const existing = readFileSync(destination);
    if (existing.byteLength !== content.byteLength || sha256(existing) !== hash) {
      throw storeError('STATE_INTEGRITY_FAILURE', `blob ${hash} is corrupt`);
    }
    chmodSync(destination, 0o600);
    return { hash, kind, byte_length: content.byteLength };
  }

  const temporary = join(shard, `.${hash}.${randomUUID()}.tmp`);
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  try {
    linkSync(temporary, destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    verifyRegularPrivateFile(destination);
    const existing = readFileSync(destination);
    if (existing.byteLength !== content.byteLength || sha256(existing) !== hash) {
      throw storeError('STATE_INTEGRITY_FAILURE', `blob ${hash} is corrupt`);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  chmodSync(destination, 0o600);
  return { hash, kind, byte_length: content.byteLength };
}

function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch {
    // The original transaction error is authoritative.
  }
}

export class SessionStore {
  constructor({ stateRoot, clock = () => new Date(), faultInjector = () => {}, targetRoots = [] }) {
    assertStableStateRoot({ stateRoot, targetRoots });
    ensurePrivateDirectory(stateRoot);
    this.stateRoot = stateRoot;
    this.clock = clock;
    this.faultInjector = faultInjector;
    this.blobsRoot = join(stateRoot, 'blobs', 'sha256');
    ensurePrivateDirectory(join(stateRoot, 'blobs'));
    ensurePrivateDirectory(this.blobsRoot);

    const keyPath = join(stateRoot, 'controller.key');
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    verifyRegularPrivateFile(keyPath);
    if (readFileSync(keyPath).byteLength !== 32) {
      throw storeError('STATE_INTEGRITY_FAILURE', 'controller.key has an invalid byte length');
    }
    chmodSync(keyPath, 0o600);
    ensurePrivateFile(join(stateRoot, 'controller.meta.json'), META_BYTES);

    const databasePath = join(stateRoot, 'sessions.db');
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        previous_event_hash TEXT,
        event_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    this.db.enableDefensive(true);
  }

  create(session) {
    const diagnostics = validateGoalSession(session);
    if (diagnostics.length > 0) {
      throw storeError('GOAL_SESSION_INVALID', diagnostics.map((entry) => entry.code).join(','));
    }
    if (session.revision !== 0) throw storeError('SESSION_REVISION_INVALID', 'new sessions must start at revision 0');
    const stateJson = canonicalState(session);
    const stateHash = digestCanonical(session);
    const createdAt = timestamp(this.clock);
    const eventBody = {
      session_id: session.session_id,
      sequence: 1,
      event_type: 'SESSION_CREATED',
      payload_hash: stateHash,
      previous_event_hash: null,
      created_at: createdAt,
    };
    const eventHash = eventDigest(eventBody);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO sessions (session_id, schema_version, revision, status, state_json, state_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.session_id,
        session.schema_version,
        session.revision,
        session.status,
        stateJson,
        stateHash,
        createdAt,
      );
      this.db.prepare(`
        INSERT INTO events (session_id, sequence, event_type, payload_hash, previous_event_hash, event_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.session_id,
        1,
        'SESSION_CREATED',
        stateHash,
        null,
        eventHash,
        createdAt,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      rollback(this.db);
      if (error.code === 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw storeError('SESSION_ALREADY_EXISTS', `session ${session.session_id} already exists`);
      }
      throw error;
    }
    return structuredClone(session);
  }

  read(sessionId) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    if (row === undefined) throw storeError('SESSION_NOT_FOUND', `session ${sessionId} was not found`);
    let session;
    try {
      session = JSON.parse(row.state_json);
    } catch {
      throw storeError('STATE_INTEGRITY_FAILURE', `session ${sessionId} has invalid JSON`);
    }
    if (digestCanonical(session) !== row.state_hash
      || session.revision !== row.revision
      || session.status !== row.status
      || session.schema_version !== row.schema_version) {
      throw storeError('STATE_INTEGRITY_FAILURE', `session ${sessionId} state does not match its index`);
    }
    const diagnostics = validateGoalSession(session);
    if (diagnostics.length > 0) {
      throw storeError('STATE_INTEGRITY_FAILURE', diagnostics.map((entry) => entry.code).join(','));
    }
    this.#verifiedEvents(sessionId);
    this.#verifyRegisteredBlobs();
    return session;
  }

  compareAndCommit({ sessionId, expectedRevision, eventType, nextState, blobs }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw storeError('SESSION_REVISION_INVALID', 'expectedRevision must be a non-negative integer');
    }
    if (typeof eventType !== 'string' || eventType.trim().length === 0) {
      throw storeError('EVENT_TYPE_INVALID', 'eventType must be a non-empty string');
    }
    if (!Array.isArray(blobs)) throw storeError('BLOBS_INVALID', 'blobs must be an array');
    const descriptors = blobs.map((blob) => publishBlob({ blobsRoot: this.blobsRoot, ...blob }));
    if (descriptors.length > 0) this.faultInjector('after_blob_publish');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare(
        'SELECT revision, state_hash FROM sessions WHERE session_id = ?',
      ).get(sessionId);
      if (current === undefined) throw storeError('SESSION_NOT_FOUND', `session ${sessionId} was not found`);
      if (current.revision !== expectedRevision) {
        throw storeError(
          'SESSION_REVISION_CONFLICT',
          `session ${sessionId} is at revision ${current.revision}, expected ${expectedRevision}`,
        );
      }
      if (nextState.session_id !== sessionId) {
        throw storeError('SESSION_ID_MISMATCH', 'nextState belongs to another session');
      }
      const committed = structuredClone(nextState);
      committed.revision = expectedRevision + 1;
      const diagnostics = validateGoalSession(committed);
      if (diagnostics.length > 0) {
        throw storeError('GOAL_SESSION_INVALID', diagnostics.map((entry) => entry.code).join(','));
      }
      const stateJson = canonicalState(committed);
      const stateHash = digestCanonical(committed);
      const createdAt = timestamp(this.clock);
      const previous = this.db.prepare(
        'SELECT sequence, event_hash FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1',
      ).get(sessionId);
      const sequence = previous.sequence + 1;
      const eventBody = {
        session_id: sessionId,
        sequence,
        event_type: eventType,
        payload_hash: stateHash,
        previous_event_hash: previous.event_hash,
        created_at: createdAt,
      };
      const eventHash = eventDigest(eventBody);
      this.db.prepare(`
        UPDATE sessions
        SET revision = ?, status = ?, state_json = ?, state_hash = ?, updated_at = ?
        WHERE session_id = ? AND revision = ?
      `).run(
        committed.revision,
        committed.status,
        stateJson,
        stateHash,
        createdAt,
        sessionId,
        expectedRevision,
      );
      this.db.prepare(`
        INSERT INTO events (session_id, sequence, event_type, payload_hash, previous_event_hash, event_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        sequence,
        eventType,
        stateHash,
        previous.event_hash,
        eventHash,
        createdAt,
      );
      const insertBlob = this.db.prepare(
        'INSERT OR IGNORE INTO blobs (hash, kind, byte_length, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const descriptor of descriptors) {
        insertBlob.run(descriptor.hash, descriptor.kind, descriptor.byte_length, createdAt);
      }
      this.db.exec('COMMIT');
      return committed;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  putBlob({ kind, bytes }) {
    const descriptor = publishBlob({ blobsRoot: this.blobsRoot, kind, bytes });
    const createdAt = timestamp(this.clock);
    this.db.prepare(
      'INSERT OR IGNORE INTO blobs (hash, kind, byte_length, created_at) VALUES (?, ?, ?, ?)',
    ).run(descriptor.hash, descriptor.kind, descriptor.byte_length, createdAt);
    return descriptor;
  }

  getBlob(hash) {
    if (typeof hash !== 'string' || !SHA256.test(hash)) {
      throw storeError('BLOB_HASH_INVALID', 'blob hash must be lowercase SHA-256');
    }
    const row = this.db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hash);
    if (row === undefined) throw storeError('BLOB_NOT_FOUND', `blob ${hash} was not registered`);
    const path = join(this.blobsRoot, hash.slice(0, 2), hash);
    if (!existsSync(path)) throw storeError('STATE_INTEGRITY_FAILURE', `blob ${hash} is missing`);
    verifyRegularPrivateFile(path);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== row.byte_length || sha256(bytes) !== hash) {
      throw storeError('STATE_INTEGRITY_FAILURE', `blob ${hash} is corrupt`);
    }
    return bytes;
  }

  exportSession(sessionId) {
    const session = this.read(sessionId);
    const events = this.db.prepare(
      'SELECT sequence, event_type, payload_hash, previous_event_hash, event_hash, created_at FROM events WHERE session_id = ? ORDER BY sequence',
    ).all(sessionId);
    const blobs = this.db.prepare(
      'SELECT hash, kind, byte_length, created_at FROM blobs ORDER BY hash',
    ).all();
    return { session, events, blobs };
  }

  close() {
    this.db.close();
  }

  #verifiedEvents(sessionId) {
    const rows = this.db.prepare(
      'SELECT sequence, event_type, payload_hash, previous_event_hash, event_hash, created_at FROM events WHERE session_id = ? ORDER BY sequence',
    ).all(sessionId);
    let previousHash = null;
    rows.forEach((row, index) => {
      const sequence = index + 1;
      const body = {
        session_id: sessionId,
        sequence: row.sequence,
        event_type: row.event_type,
        payload_hash: row.payload_hash,
        previous_event_hash: row.previous_event_hash,
        created_at: row.created_at,
      };
      if (row.sequence !== sequence
        || row.previous_event_hash !== previousHash
        || row.event_hash !== eventDigest(body)) {
        throw storeError('STATE_INTEGRITY_FAILURE', `session ${sessionId} event chain is corrupt`);
      }
      previousHash = row.event_hash;
    });
    if (rows.length === 0) throw storeError('STATE_INTEGRITY_FAILURE', `session ${sessionId} has no ledger`);
    return rows;
  }

  #verifyRegisteredBlobs() {
    const rows = this.db.prepare('SELECT hash FROM blobs').all();
    for (const row of rows) this.getBlob(row.hash);
  }
}

export function openSessionStore(options) {
  return new SessionStore(options);
}
