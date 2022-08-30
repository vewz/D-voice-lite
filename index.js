"use strict";

const EventEmitter = require("node:events");
const VoiceUDPSocket = require("./udp.js");
const VoiceWebSocket = require("./ws.js");

const CHANNELS = 2;
const TIMESTAMP_INC = (48000 / 100) * CHANNELS;
const MAX_NONCE_SIZE = 2 ** 32 - 1;
const SUPPORTED_ENCRYPTION_MODES = Object.freeze(["xsalsa20_poly1305_lite", "xsalsa20_poly1305_suffix", "xsalsa20_poly1305"]);
const nonce = Buffer.alloc(24);

const NetworkingStatusCode = new Proxy(
  Object.freeze({
    __proto__: null,
    OpeningWs: "OPENING_WS",
    Identifying: "IDENTIFYING",
    UdpHandshaking: "UDP_HANDSHAKING",
    SelectingProtocol: "SELECTING_PROTOCOL",
    Ready: "READY",
    Resuming: "RESUMING",
    Closed: "CLOSED"
  }),
  {
    __proto__: null,
    get(target, name) {
      if (name in target) return target[name];
      throw new TypeError(`Invalid NetworkingStatusCode: ${String(name)}`);
    }
  }
);

const VoiceOpcode = new Proxy(
  Object.freeze({
    __proto__: null,
    Identify: 0,
    SelectProtocol: 1,
    Ready: 2,
    Heartbeat: 3,
    SessionDescription: 4,
    Speaking: 5,
    HeartbeatAck: 6,
    Resume: 7,
    Hello: 8,
    Resumed: 9,
    ClientConnect: 12,
    ClientDisconnect: 13,
    Codec: 14
  }),
  {
    __proto__: null,
    get(target, name) {
      if (name in target) return target[name];
      throw new TypeError(`Invalid VoiceOpcode: ${String(name)}`);
    }
  }
);

const secretboxMethods = (() => {
  const fallbackError = () => {
    throw new Error(
      "Cannot play audio as no valid encryption package is installed.\n" +
        "  - Install sodium, libsodium-wrappers, or tweetnacl.\n" +
        "  - Use the generateDependencyReport() function for more information.\n"
    );
  };
  return {
    __proto__: null,
    open: fallbackError,
    close: fallbackError,
    randomBytes: fallbackError
  };
})();

const noop = () => void 0;

const randomNBit = n => Math.floor(Math.random() * 2 ** n);

function createWebSocket(endpoint, { onChildError, onWsOpen, onWsPacket, onWsClose }) {
  const ws = new VoiceWebSocket(`wss://${endpoint}?v=4`);
  ws.on("error", onChildError);
  ws.once("open", onWsOpen);
  ws.on("packet", onWsPacket);
  ws.once("close", onWsClose);
  return ws;
}

const handlerMap = new WeakMap();

class Networking extends EventEmitter {
  #state;
  #encryptedBuffers = new WeakSet();
  constructor(options) {
    super();
    const { endpoint } = options;
    this.#state = Object.freeze({
      code: NetworkingStatusCode.OpeningWs,
      ws: createWebSocket(endpoint, this.#getBoundHandlers(this))
    });
    Object.defineProperty(this, "endpoint", { value: endpoint, enumerable: true });
    Object.defineProperty(this, "serverId", { value: options.serverId, enumerable: true });
    Object.defineProperty(this, "userId", { value: options.userId, enumerable: true });
    Object.defineProperty(this, "sessionId", { value: options.sessionId, enumerable: true });
    Object.defineProperty(this, "token", { value: options.token, enumerable: true });
  }
  destroy() {
    this.#updateState({ code: NetworkingStatusCode.Closed });
  }
  encryptAudioPacket(opusPacket) {
    const { connectionData, code } = this.#state;
    if (code !== NetworkingStatusCode.Ready && code !== NetworkingStatusCode.Resuming) return undefined;
    const packetBuffer = Buffer.alloc(12);
    packetBuffer[0] = 0x80;
    packetBuffer[1] = 0x78;
    const { secretKey, encryptionMode, nonceBuffer, sequence, timestamp, ssrc } = connectionData;
    packetBuffer.writeUIntBE(sequence, 2, 2);
    packetBuffer.writeUIntBE(timestamp, 4, 4);
    packetBuffer.writeUIntBE(ssrc, 8, 4);
    packetBuffer.copy(nonce, 0, 0, 12);
    let preparedPacket;
    if (encryptionMode === "xsalsa20_poly1305_lite") {
      connectionData.nonce++;
      if (MAX_NONCE_SIZE < connectionData.nonce) connectionData.nonce = 0;
      nonceBuffer.writeUInt32BE(connectionData.nonce, 0);
      preparedPacket = Buffer.concat([packetBuffer, secretboxMethods.close(opusPacket, nonceBuffer, secretKey), nonceBuffer.slice(0, 4)]);
    } else if (encryptionMode === "xsalsa20_poly1305_suffix") {
      const random = secretboxMethods.randomBytes(24, nonceBuffer);
      preparedPacket = Buffer.concat([packetBuffer, secretboxMethods.close(opusPacket, random, secretKey), random]);
    } else {
      preparedPacket = Buffer.concat([packetBuffer, secretboxMethods.close(opusPacket, nonce, secretKey)]);
    }
    this.#encryptedBuffers.add(preparedPacket);
    return preparedPacket;
  }
  sendEncryptedPacket(buffer) {
    const { code, connectionData, udp } = this.#state;
    if (code !== NetworkingStatusCode.Ready) return false;
    if (!this.#encryptedBuffers.has(buffer)) return false;
    connectionData.sequence++;
    connectionData.timestamp += TIMESTAMP_INC;
    if (connectionData.sequence >= 2 ** 16) connectionData.sequence = 0;
    if (connectionData.timestamp >= 2 ** 32) connectionData.timestamp = 0;
    this.setSpeaking(true);
    udp.send(buffer);
    return true;
  }
  setSpeaking(speaking) {
    const { code, connectionData, ws } = this.#state;
    if (code !== NetworkingStatusCode.Ready) return;
    if (connectionData.speaking === speaking) return;
    connectionData.speaking = speaking;
    ws.sendPacket({
      op: VoiceOpcode.Speaking,
      d: {
        speaking: speaking ? 1 : 0,
        delay: 0,
        ssrc: connectionData.ssrc
      }
    });
  }
  get state() {
    return this.#state;
  }
  decryptAudioPacket(buffer) {
    const {
      connectionData: { encryptionMode, nonceBuffer, secretKey },
      code
    } = this.#state;
    if (code !== NetworkingStatusCode.Ready && code !== NetworkingStatusCode.Resuming) return undefined;
    if (!encryptionMode || !nonceBuffer || !secretKey) return undefined;
    let end;
    if (encryptionMode === "xsalsa20_poly1305_lite") {
      buffer.copy(nonceBuffer, 0, buffer.length - 4);
      end = buffer.length - 4;
    } else if (encryptionMode === "xsalsa20_poly1305_suffix") {
      buffer.copy(nonceBuffer, 0, buffer.length - 24);
      end = buffer.length - 24;
    } else {
      buffer.copy(nonceBuffer, 0, 0, 12);
    }
    const decrypted = secretboxMethods.open(buffer.slice(12, end), nonceBuffer, secretKey);
    if (!decrypted) return undefined;
    let packet = Buffer.from(decrypted);
    if (packet[0] === 0xbe && packet[1] === 0xde && 4 < packet.length) {
      const headerExtensionLength = packet.readUInt16BE(2);
      let offset = 4;
      for (let i = 0; i < headerExtensionLength; i++) {
        const byte = packet[offset];
        offset++;
        if (byte === 0) continue;
        offset += 1 + (byte >> 4);
      }
      const byte = packet.readUInt8(offset);
      if (byte === 0x00 || byte === 0x02) offset++;
      packet = packet.slice(offset);
    }
    return packet;
  }
  #updateState(newState) {
    const oldWs = this.#state.ws;
    const newWs = newState.ws;
    const { onChildError, onWsOpen, onWsPacket, onWsClose, onUdpPacket, onUdpClose } = this.#getBoundHandlers(this);
    if (oldWs && oldWs !== newWs) {
      oldWs.on("error", noop);
      oldWs.off("error", onChildError);
      oldWs.off("open", onWsOpen);
      oldWs.off("packet", onWsPacket);
      oldWs.off("close", onWsClose);
      oldWs.destroy();
    }
    const oldUdp = this.#state.udp;
    const newUdp = newState.udp;
    if (oldUdp && oldUdp !== newUdp) {
      oldUdp.on("error", noop);
      oldUdp.off("error", onChildError);
      oldUdp.off("message", onUdpPacket);
      oldUdp.off("close", onUdpClose);
      oldUdp.destroy();
    }
    const oldState = this.#state;
    this.#state = Object.freeze(newState);
    if (oldState.code !== newState.code) this.emit(newState.code);
    this.emit("stateChange", oldState, newState);
  }
  #getBoundHandlers() {
    if (handlerMap.has(this)) return handlerMap.get(this);
    const methods = {
      onChildError: this.#onChildErrorUnbound.bind(this),
      onWsOpen: this.#onWsOpenUnbound.bind(this),
      onWsPacket: this.#onWsPacketUnbound.bind(this),
      onWsClose: this.#onWsCloseUnbound.bind(this),
      onUdpPacket: this.#onUdpPacketUnbound.bind(this),
      onUdpClose: this.#onUdpCloseUnbound.bind(this)
    };
    handlerMap.set(this, methods);
    return methods;
  }
  #onChildErrorUnbound(error) {
    this.emit("error", error);
  }
  #onUdpPacketUnbound(msg) {
    if (msg.length <= 8) return;
    const ssrc = msg.readUInt32BE(8);
    this.emit("udpPacket", { ssrc, encryptedBuffer: msg });
  }
  async #onWsPacketUnbound(packet) {
    setImmediate(() => this.emit("wsMessage", packet));
    setImmediate(() => this.emit(`op:${packet.op}`, packet.d));
    const { ws, code, connectionData } = this.#state;
    if (packet.op === VoiceOpcode.Ready && code === NetworkingStatusCode.Identifying) {
      const { onChildError, onUdpPacket, onUdpClose } = this.#getBoundHandlers(this);
      const { ip, port, ssrc, modes } = packet.d;
      const udp = new VoiceUDPSocket(ip, port);
      udp.on("error", onChildError);
      udp.on("message", onUdpPacket);
      udp.once("close", onUdpClose);
      this.#updateState({
        ...this.#state,
        code: NetworkingStatusCode.UdpHandshaking,
        udp,
        connectionData: Object.seal({ ssrc })
      });
      try {
        const localConfig = await udp.performIPDiscovery(ssrc);
        if (this.#state.code !== NetworkingStatusCode.UdpHandshaking) return;
        const mode = modes.find(opt => SUPPORTED_ENCRYPTION_MODES.includes(opt));
        if (!mode) throw new Error(`No compatible encryption modes. Available include: ${modes.join(", ")}`);
        ws.sendPacket({
          op: 1,
          d: {
            protocol: "udp",
            data: {
              address: localConfig.ip,
              port: localConfig.port,
              mode
            }
          }
        });
        this.#updateState({
          ...this.#state,
          code: NetworkingStatusCode.SelectingProtocol
        });
      } catch (error) {
        this.emit("error", error);
      }
      return;
    }
    if (packet.op === VoiceOpcode.SessionDescription && code === NetworkingStatusCode.SelectingProtocol) {
      const { mode: encryptionMode, secret_key: secretKey } = packet.d;
      this.#updateState({
        ...this.#state,
        code: NetworkingStatusCode.Ready,
        connectionData: Object.seal({
          ...connectionData,
          encryptionMode,
          secretKey: new Uint8Array(secretKey),
          sequence: randomNBit(16),
          timestamp: randomNBit(32),
          nonce: 0,
          nonceBuffer: Buffer.alloc(24),
          speaking: false
        })
      });
      return;
    }
    if (packet.op === VoiceOpcode.Resumed && code === NetworkingStatusCode.Resuming) {
      this.#updateState({
        ...this.#state,
        code: NetworkingStatusCode.Ready
      });
      connectionData.speaking = false;
    }
  }
  #onWsCloseUnbound({ code }) {
    const state = this.#state;
    if ((code === 4015 || code < 4000) && state.code === NetworkingStatusCode.Ready) {
      this.#updateState({
        ...state,
        code: NetworkingStatusCode.Resuming,
        ws: createWebSocket(this.endpoint, this.#getBoundHandlers(this))
      });
      return;
    }
    if (state.code !== NetworkingStatusCode.Closed) {
      this.destroy();
      this.emit("close", code);
    }
  }
  #onUdpCloseUnbound() {
    const state = this.#state;
    if (state.code === NetworkingStatusCode.Ready) {
      this.#updateState({
        ...state,
        code: NetworkingStatusCode.Resuming,
        ws: createWebSocket(this.endpoint, this.#getBoundHandlers(this))
      });
    }
  }
  #onWsOpenUnbound() {
    const { code, ws } = this.#state;
    if (code === NetworkingStatusCode.OpeningWs) {
      ws.sendPacket({
        op: VoiceOpcode.Identify,
        d: {
          server_id: this.serverId,
          user_id: this.userId,
          session_id: this.sessionId,
          token: this.token
        }
      });
      this.#updateState({
        ...this.#state,
        code: NetworkingStatusCode.Identifying
      });
      return;
    }
    if (code === NetworkingStatusCode.Resuming) {
      ws.sendPacket({
        op: VoiceOpcode.Resume,
        d: {
          server_id: this.serverId,
          session_id: this.sessionId,
          token: this.token
        }
      });
    }
  }
}

Object.freeze(Networking);
Object.freeze(Networking.prototype);

function setEncryptionMethods(methods) {
  if (typeof methods?.open == "function") secretboxMethods.open = methods.open;
  if (typeof methods?.close == "function") secretboxMethods.close = methods.close;
  if (typeof methods?.randomBytes == "function") secretboxMethods.randomBytes = methods.randomBytes;
}

Object.assign(exports, { Networking, NetworkingStatusCode, VoiceOpcode, setEncryptionMethods, VoiceUDPSocket, VoiceWebSocket });
