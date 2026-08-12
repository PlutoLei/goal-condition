import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson } from '../../scripts/lib/contract.mjs';
import { validateGoalSession } from './domain.mjs';
import { assertCreationRequestId } from './identity.mjs';
import { assertStableStateRoot, digestCanonical, exactFields } from './values.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const CREATION_KINDS = new Set(['session', 'run']);
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

function canonicalRoot(path) {
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch {
    throw storeError('TARGET_ROOT_INVALID', 'target roots must exist and resolve without symlinks');
  }
  if (canonical !== path) {
    throw storeError('TARGET_ROOT_SYMLINKED', 'target roots must use canonical physical paths');
  }
  return canonical;
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory() || realpathSync(path) !== path) {
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

function validateCreationRequest(request, expectedKind = null) {
  exactFields(request, ['kind', 'scopeId', 'requestKey', 'requestHash'], 'creation_request');
  if (!CREATION_KINDS.has(request.kind) || (expectedKind !== null && request.kind !== expectedKind)) {
    throw storeError('CREATION_REQUEST_KIND_INVALID', 'creation request kind does not match the resource');
  }
  if (typeof request.scopeId !== 'string' || request.scopeId.trim().length === 0) {
    throw storeError('CREATION_REQUEST_SCOPE_INVALID', 'creation request scope must be a non-empty string');
  }
  assertCreationRequestId(request.requestKey);
  if (typeof request.requestHash !== 'string' || !SHA256.test(request.requestHash)) {
    throw storeError('CREATION_REQUEST_HASH_INVALID', 'creation request hash must be lowercase SHA-256');
  }
}

export class SessionStore {
  constructor({ stateRoot, clock = () => new Date(), faultInjector = () => {}, targetRoots = [] }) {
    assertStableStateRoot({ stateRoot, targetRoots });
    ensurePrivateDirectory(stateRoot);
    assertStableStateRoot({ stateRoot, targetRoots });
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
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
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
      CREATE TABLE IF NOT EXISTS launch_intents (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        status TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        intent_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS creation_receipts (
        kind TEXT NOT NULL CHECK (kind IN ('session', 'run')),
        scope_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        identifier TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, scope_id, request_key),
        UNIQUE (kind, identifier)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS target_leases (
        root TEXT NOT NULL,
        session_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        writable INTEGER NOT NULL CHECK (writable IN (0, 1)),
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (root, run_id)
      ) STRICT;
    `);
    this.db.enableDefensive(true);
  }

  readCreationReceipt(request) {
    validateCreationRequest(request);
    const row = this.db.prepare(`
      SELECT kind, scope_id, request_key, request_hash, identifier, created_at
      FROM creation_receipts
      WHERE kind = ? AND scope_id = ? AND request_key = ?
    `).get(request.kind, request.scopeId, request.requestKey);
    if (row === undefined) return null;
    if (row.request_hash !== request.requestHash) {
      throw storeError(
        'CREATION_REQUEST_CONFLICT',
        'a creation request id was reused with different immutable input',
      );
    }
    return {
      kind: row.kind,
      scopeId: row.scope_id,
      requestKey: row.request_key,
      requestHash: row.request_hash,
      identifier: row.identifier,
      createdAt: row.created_at,
    };
  }

  #insertCreationReceipt({ request, identifier, createdAt }) {
    this.db.prepare(`
      INSERT INTO creation_receipts (
        kind, scope_id, request_key, request_hash, identifier, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      request.kind,
      request.scopeId,
      request.requestKey,
      request.requestHash,
      identifier,
      createdAt,
    );
  }

  create(session, { creationRequest = null, blobs = [] } = {}) {
    const diagnostics = validateGoalSession(session);
    if (diagnostics.length > 0) {
      throw storeError('GOAL_SESSION_INVALID', diagnostics.map((entry) => entry.code).join(','));
    }
    if (session.revision !== 0) throw storeError('SESSION_REVISION_INVALID', 'new sessions must start at revision 0');
    if (!Array.isArray(blobs)) throw storeError('BLOBS_INVALID', 'blobs must be an array');
    if (creationRequest !== null) validateCreationRequest(creationRequest, 'session');
    if (creationRequest !== null && creationRequest.scopeId !== 'machine') {
      throw storeError('CREATION_REQUEST_SCOPE_INVALID', 'session creation requests use the machine scope');
    }
    const descriptors = blobs.map((blob) => publishBlob({ blobsRoot: this.blobsRoot, ...blob }));
    if (descriptors.length > 0) this.faultInjector('after_blob_publish');
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
      if (creationRequest !== null) {
        const existing = this.readCreationReceipt(creationRequest);
        if (existing !== null) {
          this.db.exec('COMMIT');
          return this.read(existing.identifier);
        }
      }
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
      const insertBlob = this.db.prepare(
        'INSERT OR IGNORE INTO blobs (hash, kind, byte_length, created_at) VALUES (?, ?, ?, ?)',
      );
      for (const descriptor of descriptors) {
        insertBlob.run(descriptor.hash, descriptor.kind, descriptor.byte_length, createdAt);
      }
      if (creationRequest !== null) {
        this.#insertCreationReceipt({
          request: creationRequest,
          identifier: session.session_id,
          createdAt,
        });
        this.faultInjector('after_session_creation_receipt_insert');
      }
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

  #commitSessionInTransaction({ sessionId, expectedRevision, eventType, nextState, descriptors = [] }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw storeError('SESSION_REVISION_INVALID', 'expectedRevision must be a non-negative integer');
    }
    if (typeof eventType !== 'string' || eventType.trim().length === 0) {
      throw storeError('EVENT_TYPE_INVALID', 'eventType must be a non-empty string');
    }
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
    const updated = this.db.prepare(`
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
    if (updated.changes !== 1) {
      throw storeError('SESSION_REVISION_CONFLICT', 'session changed concurrently');
    }
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
    return committed;
  }

  compareAndCommit({ sessionId, expectedRevision, eventType, nextState, blobs }) {
    if (!Array.isArray(blobs)) throw storeError('BLOBS_INVALID', 'blobs must be an array');
    const descriptors = blobs.map((blob) => publishBlob({ blobsRoot: this.blobsRoot, ...blob }));
    if (descriptors.length > 0) this.faultInjector('after_blob_publish');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const committed = this.#commitSessionInTransaction({
        sessionId, expectedRevision, eventType, nextState, descriptors,
      });
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

  controllerKeyId() {
    return `key-${sha256(readFileSync(join(this.stateRoot, 'controller.key'))).slice(0, 16)}`;
  }

  controllerMac(value) {
    const key = readFileSync(join(this.stateRoot, 'controller.key'));
    return createHmac('sha256', key).update(canonicalJson(value)).digest('hex');
  }

  #leaseConflict(roots, now, writable) {
    const current = this.db.prepare(
      "SELECT * FROM target_leases WHERE status IN ('active', 'reconciliation_required')",
    ).all();
    for (const row of current) {
      if (!roots.some((root) => overlaps(root, row.root))) continue;
      if (!writable && row.writable !== 1) continue;
      if (row.status === 'active' && new Date(row.expires_at).getTime() <= new Date(now).getTime()) {
        this.db.prepare(
          "UPDATE target_leases SET status = 'reconciliation_required', updated_at = ? WHERE root = ?",
        ).run(now, row.root);
        return storeError(
          'TARGET_ROOT_LEASE_RECONCILIATION_REQUIRED',
          'an expired writable lease must be reconciled before takeover',
        );
      }
      if (row.status === 'reconciliation_required') {
        return storeError(
          'TARGET_ROOT_LEASE_RECONCILIATION_REQUIRED',
          'a writable lease requires reconciliation before takeover',
        );
      }
      return storeError('TARGET_ROOT_LEASE_CONFLICT', 'a target root already has a writable controller owner');
    }
    return null;
  }

  #insertLeases({ roots, sessionId, attemptId, runId, ownerToken, expiresAt, writable, now }) {
    const insert = this.db.prepare(`
      INSERT INTO target_leases (
        root, session_id, attempt_id, run_id, owner_token, writable, status, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `);
    for (const root of roots) {
      insert.run(root, sessionId, attemptId, runId, ownerToken, writable ? 1 : 0, expiresAt, now);
    }
  }

  acquireRootLeases({ roots, sessionId, attemptId, runId, ownerToken, expiresAt, writable }) {
    if (!Array.isArray(roots) || roots.length === 0) throw storeError('TARGET_ROOTS_INVALID', 'roots are required');
    const canonical = [...new Set(roots.map(canonicalRoot))].sort();
    const now = timestamp(this.clock);
    if (Number.isNaN(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() <= new Date(now).getTime()) {
      throw storeError('TARGET_ROOT_LEASE_EXPIRY_INVALID', 'lease expiry must be in the future');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const conflict = this.#leaseConflict(canonical, now, writable);
      if (conflict !== null) {
        this.db.exec('COMMIT');
        throw conflict;
      }
      this.#insertLeases({
        roots: canonical, sessionId, attemptId, runId, ownerToken, expiresAt, writable, now,
      });
      this.db.exec('COMMIT');
      return canonical.map((root) => this.readRootLease(root));
    } catch (error) {
      rollback(this.db);
      if (error.code === 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw storeError('TARGET_ROOT_LEASE_CONFLICT', 'a target root already has a controller owner');
      }
      throw error;
    }
  }

  persistLaunchIntent({ intent, roots, ownerToken, writable = true, creationRequest = null }) {
    if (creationRequest !== null) validateCreationRequest(creationRequest, 'run');
    if (creationRequest !== null && creationRequest.scopeId !== intent.session_id) {
      throw storeError('CREATION_REQUEST_SCOPE_INVALID', 'run creation requests use their session scope');
    }
    const canonical = [...new Set(roots.map(canonicalRoot))].sort();
    const now = timestamp(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (creationRequest !== null) {
        const existing = this.readCreationReceipt(creationRequest);
        if (existing !== null) {
          this.db.exec('COMMIT');
          return this.readLaunchIntent(existing.identifier);
        }
      }
      const conflict = this.#leaseConflict(canonical, now, writable);
      if (conflict !== null) {
        this.db.exec('COMMIT');
        throw conflict;
      }
      this.#insertLeases({
        roots: canonical,
        sessionId: intent.session_id,
        attemptId: intent.attempt_id,
        runId: intent.run_id,
        ownerToken,
        expiresAt: intent.expires_at,
        writable,
        now,
      });
      const intentJson = canonicalJson(intent);
      this.db.prepare(`
        INSERT INTO launch_intents (
          run_id, session_id, attempt_id, status, intent_json, intent_hash, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        intent.run_id, intent.session_id, intent.attempt_id,
        intentJson, digestCanonical(intent), now, now,
      );
      if (creationRequest !== null) {
        this.#insertCreationReceipt({
          request: creationRequest,
          identifier: intent.run_id,
          createdAt: now,
        });
        this.faultInjector('after_run_creation_receipt_insert');
      }
      this.db.exec('COMMIT');
      return this.readLaunchIntent(intent.run_id);
    } catch (error) {
      rollback(this.db);
      if (error.code === 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw storeError('LAUNCH_INTENT_CONFLICT', 'run id or target root already exists');
      }
      throw error;
    }
  }

  readLaunchIntent(runId) {
    const row = this.db.prepare('SELECT * FROM launch_intents WHERE run_id = ?').get(runId);
    if (row === undefined) throw storeError('LAUNCH_INTENT_NOT_FOUND', 'launch intent was not found');
    let intent;
    try {
      intent = JSON.parse(row.intent_json);
    } catch {
      throw storeError('STATE_INTEGRITY_FAILURE', 'launch intent JSON is corrupt');
    }
    if (digestCanonical(intent) !== row.intent_hash) {
      throw storeError('STATE_INTEGRITY_FAILURE', 'launch intent hash does not match');
    }
    return { ...intent, status: row.status };
  }

  claimLaunchIntent({ runId }) {
    const now = timestamp(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        'SELECT status, intent_json, intent_hash FROM launch_intents WHERE run_id = ?',
      ).get(runId);
      if (row === undefined) throw storeError('LAUNCH_INTENT_NOT_FOUND', 'launch intent was not found');
      if (row.status !== 'pending') {
        throw storeError('LAUNCH_INTENT_NOT_PENDING', 'only a pending launch intent may be dispatched');
      }
      let intent;
      try {
        intent = JSON.parse(row.intent_json);
      } catch {
        throw storeError('STATE_INTEGRITY_FAILURE', 'launch intent JSON is corrupt');
      }
      if (digestCanonical(intent) !== row.intent_hash) {
        throw storeError('STATE_INTEGRITY_FAILURE', 'launch intent hash does not match');
      }
      if (new Date(intent.expires_at).getTime() <= new Date(now).getTime()) {
        throw storeError('LAUNCH_INTENT_EXPIRED', 'launch intent expired before dispatch');
      }
      const updated = this.db.prepare(
        "UPDATE launch_intents SET status = 'dispatching', updated_at = ? WHERE run_id = ? AND status = 'pending'",
      ).run(now, runId);
      if (updated.changes !== 1) {
        throw storeError('LAUNCH_INTENT_NOT_PENDING', 'launch intent was claimed concurrently');
      }
      this.db.exec('COMMIT');
      return this.readLaunchIntent(runId);
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  claimLaunchIntentAndCommitSession({ runId, sessionId, expectedRevision, eventType, nextState }) {
    const now = timestamp(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        'SELECT status, intent_json, intent_hash FROM launch_intents WHERE run_id = ?',
      ).get(runId);
      if (row === undefined) throw storeError('LAUNCH_INTENT_NOT_FOUND', 'launch intent was not found');
      if (row.status !== 'pending') {
        throw storeError('LAUNCH_INTENT_NOT_PENDING', 'only a pending launch intent may be dispatched');
      }
      let intent;
      try {
        intent = JSON.parse(row.intent_json);
      } catch {
        throw storeError('STATE_INTEGRITY_FAILURE', 'launch intent JSON is corrupt');
      }
      if (digestCanonical(intent) !== row.intent_hash) {
        throw storeError('STATE_INTEGRITY_FAILURE', 'launch intent hash does not match');
      }
      if (intent.session_id !== sessionId) {
        throw storeError('LAUNCH_INTENT_SESSION_MISMATCH', 'launch intent belongs to another session');
      }
      if (new Date(intent.expires_at).getTime() <= new Date(now).getTime()) {
        throw storeError('LAUNCH_INTENT_EXPIRED', 'launch intent expired before dispatch');
      }
      const committed = this.#commitSessionInTransaction({
        sessionId, expectedRevision, eventType, nextState, descriptors: [],
      });
      const updated = this.db.prepare(
        "UPDATE launch_intents SET status = 'dispatching', updated_at = ? WHERE run_id = ? AND status = 'pending'",
      ).run(now, runId);
      if (updated.changes !== 1) {
        throw storeError('LAUNCH_INTENT_NOT_PENDING', 'launch intent was claimed concurrently');
      }
      this.faultInjector('after_atomic_dispatch_update');
      this.db.exec('COMMIT');
      return { session: committed, intent: this.readLaunchIntent(runId) };
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  updateLaunchIntentStatus({ runId, status }) {
    const transitions = {
      pending: new Set(['dispatching', 'cleanup_failed', 'closed']),
      dispatching: new Set(['launched', 'ambiguous', 'cleanup_failed', 'closed']),
      launched: new Set(['reconciled', 'cleanup_failed', 'closed']),
      ambiguous: new Set(['reconciled', 'cleanup_failed', 'closed']),
      reconciled: new Set(['cleanup_failed', 'closed']),
      cleanup_failed: new Set(['closed']),
      closed: new Set(),
    };
    if (!(status in transitions)) {
      throw storeError('LAUNCH_INTENT_STATUS_INVALID', 'launch intent status is invalid');
    }
    const now = timestamp(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT status FROM launch_intents WHERE run_id = ?').get(runId);
      if (current === undefined) throw storeError('LAUNCH_INTENT_NOT_FOUND', 'launch intent was not found');
      if (!transitions[current.status]?.has(status)) {
        throw storeError(
          'LAUNCH_INTENT_TRANSITION_INVALID',
          `launch intent cannot move from ${current.status} to ${status}`,
        );
      }
      const result = this.db.prepare(
        'UPDATE launch_intents SET status = ?, updated_at = ? WHERE run_id = ? AND status = ?',
      ).run(status, now, runId, current.status);
      if (result.changes !== 1) {
        throw storeError('LAUNCH_INTENT_TRANSITION_CONFLICT', 'launch intent status changed concurrently');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      rollback(this.db);
      throw error;
    }
    return this.readLaunchIntent(runId);
  }

  readRootLease(root, { runId } = {}) {
    const canonical = canonicalRoot(root);
    const row = runId === undefined
      ? this.db.prepare('SELECT * FROM target_leases WHERE root = ? ORDER BY writable DESC, updated_at DESC LIMIT 1').get(canonical)
      : this.db.prepare('SELECT * FROM target_leases WHERE root = ? AND run_id = ?').get(canonical, runId);
    if (row === undefined) throw storeError('TARGET_ROOT_LEASE_NOT_FOUND', 'target root lease was not found');
    return { ...row, writable: row.writable === 1 };
  }

  releaseRootLeases({ runId, ownerToken }) {
    const rows = this.db.prepare(
      'SELECT root FROM target_leases WHERE run_id = ? AND owner_token = ?',
    ).all(runId, ownerToken);
    this.db.prepare(
      'DELETE FROM target_leases WHERE run_id = ? AND owner_token = ?',
    ).run(runId, ownerToken);
    return rows.map((row) => row.root);
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
