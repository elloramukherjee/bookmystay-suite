import mongoose from 'mongoose';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

let transactionsSupported = false;

/** True when the connected deployment is a replica set / sharded cluster (multi-document transactions available). */
export function supportsTransactions(): boolean {
  return transactionOverride ?? transactionsSupported;
}

let transactionOverride: boolean | null = null;
/** Test hook: exercise the no-transaction (standalone MongoDB) code paths against a replica set. */
export function overrideTransactionSupport(value: boolean | null): void {
  transactionOverride = value;
}

/** Host(s) and database name only, for logs: credentials and query options are never printed. */
export function describeMongoUri(uri: string): { hosts: string; database: string } {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/.exec(uri);
  return { hosts: match?.[1] ?? 'unknown', database: match?.[2] || 'test' };
}

let listenersAttached = false;
/** Runtime connection events: the driver reconnects on its own, these make outages visible in the logs. */
function attachConnectionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected; the driver will keep retrying'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
}

/**
 * Connects with a few retries and backoff, so a database that is still starting (e.g. after a platform restart
 * where the app boots first) does not crash the app. Gives up after `attempts` and rethrows the last error.
 */
export async function connectDatabase(uri: string, attempts = 5): Promise<typeof mongoose> {
  const target = describeMongoUri(uri);
  let conn: typeof mongoose | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      logger.info({ ...target, attempt }, 'Connecting to MongoDB');
      conn = await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 20,
        autoIndex: true,
      });
      break;
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (attempt >= attempts) {
        logger.error({ ...target, attempt, reason }, 'MongoDB connection failed; giving up');
        throw err;
      }
      const delayMs = Math.min(2_000 * 2 ** (attempt - 1), 15_000);
      logger.warn({ ...target, attempt, reason, retryInMs: delayMs }, 'MongoDB connection failed; retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (!conn) throw new Error('MongoDB connection was not established');
  attachConnectionListeners();

  const admin = conn.connection.db?.admin();
  const hello = admin ? await admin.command({ hello: 1 }) : {};
  transactionsSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid';

  if (!transactionsSupported) {
    logger.warn(
      'MongoDB is running standalone: multi-document transactions are unavailable. ' +
        'Inventory stays consistent via guarded atomic updates, but production MUST use a replica set.',
    );
  }
  logger.info({ ...target, transactions: transactionsSupported }, 'MongoDB connected');
  return conn;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function databaseState(): 'connected' | 'connecting' | 'disconnected' | 'disconnecting' {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'] as const;
  return states[mongoose.connection.readyState as number] ?? 'disconnected';
}
