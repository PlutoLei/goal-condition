import { openSessionStore } from '../src/store.mjs';

const [, , stateRoot, sessionId] = process.argv;
const store = openSessionStore({
  stateRoot,
  faultInjector(stage) {
    if (stage === 'after_blob_publish') process.kill(process.pid, 'SIGKILL');
  },
});
const session = store.read(sessionId);
store.compareAndCommit({
  sessionId,
  expectedRevision: session.revision,
  eventType: 'MUST_NOT_COMMIT',
  nextState: { ...session, status: 'AwaitingConfirmation' },
  blobs: [{ kind: 'crash-probe', bytes: Buffer.from('orphan-safe', 'utf8') }],
});
