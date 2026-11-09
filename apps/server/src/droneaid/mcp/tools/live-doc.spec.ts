import * as Y from 'yjs';
import { withLiveDoc } from './live-doc';

function makeCtx(opts: { redis?: boolean; openFails?: boolean } = {}) {
  const connection = {
    transact: jest.fn(async (fn: (doc: Y.Doc) => void) => fn(new Y.Doc())),
    disconnect: jest.fn(async () => undefined),
  };
  const gateway = {
    lockDocument: jest.fn(async () => undefined),
    releaseLock: jest.fn(async () => 1),
    openDirectConnection: jest.fn(async () => {
      if (opts.openFails) throw new Error('load failed');
      return connection;
    }),
  };
  const ctx: any = {
    user: { id: 'u1' },
    deps: {
      collaborationGateway: gateway,
      environmentService: { isCollabDisableRedis: () => opts.redis === false },
    },
  };
  return { ctx, gateway, connection };
}

describe('withLiveDoc', () => {
  it('releases the claimed lock when the direct connection fails', async () => {
    const { ctx, gateway } = makeCtx({ openFails: true });
    await expect(withLiveDoc(ctx, 'p1', () => 1)).rejects.toThrow('load failed');
    expect(gateway.lockDocument).toHaveBeenCalledWith('page.p1');
    expect(gateway.releaseLock).toHaveBeenCalledWith('page.p1');
  });

  it('leaves the lock to the unload hook after a normal write', async () => {
    const { ctx, gateway, connection } = makeCtx();
    await expect(withLiveDoc(ctx, 'p1', () => 42)).resolves.toBe(42);
    expect(connection.disconnect).toHaveBeenCalled();
    expect(gateway.releaseLock).not.toHaveBeenCalled();
  });

  it('does not touch locks when Redis sync is disabled', async () => {
    const { ctx, gateway } = makeCtx({ redis: false, openFails: true });
    await expect(withLiveDoc(ctx, 'p1', () => 1)).rejects.toThrow('load failed');
    expect(gateway.lockDocument).not.toHaveBeenCalled();
    expect(gateway.releaseLock).not.toHaveBeenCalled();
  });

  it('rethrows the connection error even if releasing fails', async () => {
    const { ctx, gateway } = makeCtx({ openFails: true });
    gateway.releaseLock.mockRejectedValue(new Error('redis down'));
    await expect(withLiveDoc(ctx, 'p1', () => 1)).rejects.toThrow('load failed');
  });
});
