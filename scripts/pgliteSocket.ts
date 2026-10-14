/**
 * The dev/test Postgres: PGlite behind the wire protocol, with one change from the
 * library's own server — see `handleData` below. Use `startPgLiteSocketServer` instead of
 * `new PGLiteSocketServer(...)` anywhere more than one connection will touch the database,
 * which is every real use of it: the web app and the worker are separate processes, and the
 * test suite opens two clients on purpose.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketHandler, PGLiteSocketServer } from "@electric-sql/pglite-socket";

/** The protocol version in a startup packet's second word — it is the message with no type byte. */
const PROTOCOL_3_0 = 196_608;

interface Handler {
  id: number;
  active: boolean;
  socket: { writable?: boolean; write(chunk: Buffer): unknown } | null;
  messageBuffer: Buffer;
  queryQueue: {
    enqueue(
      handlerId: number,
      message: Uint8Array,
      onData: (chunk: Uint8Array) => void,
    ): Promise<number>;
  };
  handleSslRequest(): boolean;
  handleCancelRequest(): boolean;
}

/** One whole message off the front of the buffer, or nothing while it is still partial. */
function takeFrame(handler: Handler): Uint8Array | undefined {
  const buffer = handler.messageBuffer;
  if (buffer.length < 5) return undefined;
  // Every message after the startup packet is a type byte plus a length that counts itself
  // but not that byte; the startup packet is a length and nothing else.
  const startup = buffer.length >= 8 && buffer.readInt32BE(4) === PROTOCOL_3_0;
  const size = startup ? buffer.readInt32BE(0) : 1 + buffer.readInt32BE(1);
  if (size < 5 || buffer.length < size) return undefined;
  const frame = buffer.subarray(0, size);
  handler.messageBuffer = buffer.subarray(size);
  return frame;
}

/**
 * `pglite-socket` hands PGlite one protocol message at a time and lets another connection
 * take its turn in between. PGlite is a single Postgres session, so those messages share one
 * unnamed portal — and a query's Bind and its Execute are two messages. An interleaved Bind
 * replaces the portal in between, so the Execute either runs the other connection's query or
 * dies with `portal "" does not exist`. Real Postgres works through whatever the socket has
 * already delivered before listening to anyone else, so this does the same: everything in one
 * read goes to PGlite as one unit.
 */
function groupFramesPerRead(): void {
  const patched = PGLiteSocketHandler.prototype as unknown as Record<string, unknown>;
  if ((patched.handleData as { groupsFrames?: boolean } | undefined)?.groupsFrames) return;

  async function handleData(this: Handler, data: Buffer): Promise<number> {
    if (!this.socket || !this.active) return 0;
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);

    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.handleSslRequest() || this.handleCancelRequest()) continue;
      const frame = takeFrame(this);
      if (!frame) break;
      frames.push(frame);
    }
    if (frames.length === 0) return 0;

    const group =
      frames.length === 1
        ? frames[0]
        : new Uint8Array(Buffer.concat(frames.map((frame) => Buffer.from(frame))));
    await this.queryQueue.enqueue(this.id, group, (chunk) => {
      if (this.active && this.socket?.writable) this.socket.write(Buffer.from(chunk));
    });
    return group.length;
  }

  Object.defineProperty(handleData, "groupsFrames", { value: true });
  patched.handleData = handleData;
}

export interface DevSocketOptions {
  db: PGlite;
  port: number;
  maxConnections: number;
}

export async function startPgLiteSocketServer(
  options: DevSocketOptions,
): Promise<PGLiteSocketServer> {
  groupFramesPerRead();
  const server = new PGLiteSocketServer(options);
  await server.start();
  return server;
}
