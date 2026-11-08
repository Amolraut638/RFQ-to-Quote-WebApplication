/**
 * tests/helpers/fakeMongo.ts
 *
 * In-memory stand-in for the Quote/QuoteEvent collections and a mongoose session,
 * used ONLY by unit tests. It reproduces the two properties the service depends on:
 *  - findOneAndUpdate is an atomic compare-and-set on the filter (incl. status $in).
 *    The function yields to the event loop once, then holds a "lock" (single JS turn)
 *    to make concurrent callers properly interleave and only one win.
 *  - withTransaction snapshots state before each call and rolls back (quotes AND events)
 *    if the callback throws, like an aborted MongoDB transaction.
 *  - Multiple concurrent withTransaction calls are serialised via a promise mutex so
 *    their snapshots and commits do not interfere.
 */
import { vi } from 'vitest';

type Doc = Record<string, any>;

export function createFakeMongo(initial: Doc[]) {
  const state = {
    docs: initial.map((d) => ({ ...d })),
    events: [] as Doc[],
    failNextEventWrite: false,
    commits: 0,
    aborts: 0,
  };

  // Mutex: serialise concurrent transactions so snapshot/rollback is deterministic.
  let txChain: Promise<unknown> = Promise.resolve();

  const matches = (d: Doc, f: Doc) =>
    String(d.rfqId) === String(f.rfqId) &&
    d.version === f.version &&
    (f.status === undefined ||
      (typeof f.status === 'string'
        ? d.status === f.status
        : (f.status as { $in: string[] }).$in.includes(d.status)));

  const findOne = (f: Doc) => {
    const d = state.docs.find((x) => matches(x, f));
    // return a stale snapshot copy, like a real read before the transaction
    return Promise.resolve(d ? { ...d, save: vi.fn() } : null);
  };

  // findOneAndUpdate is called INSIDE a withTransaction callback which is already
  // serialised by the mutex; just do a synchronous compare-and-set.
  const findOneAndUpdate = (f: Doc, update: { $set: Doc }) => {
    const d = state.docs.find((x) => matches(x, f));
    if (!d) return Promise.resolve(null);
    Object.assign(d, update.$set);
    return Promise.resolve({ ...d });
  };

  const eventCreate = async (arr: Doc[]) => {
    if (state.failNextEventWrite) {
      state.failNextEventWrite = false;
      throw new Error('simulated QuoteEvent write failure');
    }
    state.events.push(...arr.map((e) => ({ ...e })));
    return arr;
  };

  // Build a fresh session for each startSession() call.
  // Each session's withTransaction serialises through the shared mutex so
  // concurrent transactions run one at a time (like replica-set serialisation).
  const makeSession = () => ({
    withTransaction: (fn: () => Promise<void>) => {
      // Chain onto the existing promise so transactions are serialised.
      const result = txChain.then(async () => {
        const snapDocs = state.docs.map((d) => ({ ...d }));
        const snapEvents = [...state.events];
        try {
          await fn();
          state.commits++;
        } catch (e) {
          state.docs = snapDocs;
          state.events.length = 0;
          state.events.push(...snapEvents);
          state.aborts++;
          throw e;
        }
      });
      // The next transaction waits for this one to settle (success or failure).
      txChain = result.catch(() => undefined);
      return result;
    },
    endSession: async () => undefined,
  });

  // The session factory — the spy calls this for each mongoose.startSession().
  const session = makeSession();

  return { state, findOne, findOneAndUpdate, eventCreate, session, makeSession };
}
