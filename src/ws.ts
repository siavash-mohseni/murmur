// Minimal server-side WebSocket (RFC 6455) on node:http alone, in the same
// spirit as src/webpush.ts: the protocol surface we need is small and
// well-specified, so we implement it rather than take a dependency. Only the
// server half lives here; hubs connect outbound with Node's global WebSocket
// client (undici, Node 22+).
//
// Supported: the opening handshake, text frames in and out, fragmented
// (continuation) receive, ping/pong, the close handshake, and a message size
// cap. Not supported (and not needed by the tunnel protocol): extensions,
// subprotocol negotiation, binary frames out, streaming partial messages.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE = 32 * 1024 * 1024;

export interface WsConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  readonly closed: boolean;
}

/** Complete the RFC 6455 handshake on an 'upgrade' event and return the
 * framed connection, or null (socket already destroyed) when the request is
 * not a well-formed WebSocket upgrade. */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  opts?: { maxMessageBytes?: number }
): WsConnection | null {
  const key = req.headers["sec-websocket-key"];
  const upgrade = (req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || key.length === 0) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new ServerSocket(socket, opts?.maxMessageBytes ?? DEFAULT_MAX_MESSAGE);
}

class ServerSocket implements WsConnection {
  closed = false;
  // Annotated (not inferred) so concat/subarray results, which type as
  // Buffer<ArrayBufferLike>, assign cleanly.
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentedOpcode = 0;
  private messageHandlers: ((text: string) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  constructor(private socket: Duplex, private maxMessage: number) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    socket.on("end", () => this.finish());
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandlers.push(handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  send(text: string): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    } catch {
      this.finish();
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(0x8, body));
    } catch {
      // fall through to teardown
    }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
    for (const h of this.closeHandlers) {
      try {
        h();
      } catch {
        // listener errors must not break teardown
      }
    }
  }

  private emitMessage(payload: Buffer): void {
    const text = payload.toString("utf8");
    for (const h of this.messageHandlers) {
      try {
        h(text);
      } catch {
        // a bad handler must not kill the connection
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (frame === "incomplete") return;
      if (frame === "invalid") {
        this.close(1002, "protocol error");
        return;
      }
      this.buffer = this.buffer.subarray(frame.frameLength);

      switch (frame.opcode) {
        case 0x0: {
          // continuation
          if (this.fragmentedOpcode === 0) {
            this.close(1002, "unexpected continuation");
            return;
          }
          this.fragments.push(frame.payload);
          if (this.fragmentTotal() > this.maxMessage) {
            this.close(1009, "message too large");
            return;
          }
          if (frame.fin) {
            const whole = Buffer.concat(this.fragments);
            this.fragments = [];
            this.fragmentedOpcode = 0;
            this.emitMessage(whole);
          }
          break;
        }
        case 0x1:
        case 0x2: {
          if (frame.payload.length > this.maxMessage) {
            this.close(1009, "message too large");
            return;
          }
          if (frame.fin) {
            this.emitMessage(frame.payload);
          } else {
            this.fragmentedOpcode = frame.opcode;
            this.fragments = [frame.payload];
          }
          break;
        }
        case 0x8: // close: echo and tear down
          this.close(1000);
          return;
        case 0x9: // ping -> pong with the same payload
          try {
            this.socket.write(encodeFrame(0xa, frame.payload));
          } catch {
            this.finish();
            return;
          }
          break;
        case 0xa: // pong: nothing to do
          break;
        default:
          this.close(1002, "unknown opcode");
          return;
      }
    }
  }

  private fragmentTotal(): number {
    return this.fragments.reduce((n, f) => n + f.length, 0);
  }
}

interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  frameLength: number;
}

function decodeFrame(buf: Buffer): DecodedFrame | "incomplete" | "invalid" {
  if (buf.length < 2) return "incomplete";
  const fin = (buf[0]! & 0x80) !== 0;
  if ((buf[0]! & 0x70) !== 0) return "invalid"; // RSV bits: no extensions negotiated
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  // Client-to-server frames MUST be masked (RFC 6455 §5.1).
  if (!masked) return "invalid";
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return "incomplete";
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return "incomplete";
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return "invalid";
    len = Number(big);
    offset = 10;
  }
  if (buf.length < offset + 4 + len) return "incomplete";
  const mask = buf.subarray(offset, offset + 4);
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    payload[i] = buf[offset + 4 + i]! ^ mask[i % 4]!;
  }
  return { fin, opcode, payload, frameLength: offset + 4 + len };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
