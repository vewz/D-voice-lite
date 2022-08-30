"use strict";

const EventEmitter = require("node:events");
const WebSocket = require("./websocket");

class VoiceWebSocket extends EventEmitter {
  #ws;
  #lastHeartbeatAck = 0;
  #lastHeartbeatSend = 0;
  #missedHeartbeats = 0;
  #heartbeatInterval;
  constructor(address) {
    if (typeof address !== "string") throw new TypeError("Address must be a string");
    super();
    Object.defineProperty(this, "ping", { value: NaN, writable: true, enumerable: true });
    this.#ws = new WebSocket(address);
    this.#ws.onmessage = e => this.#onMessage(e);
    this.#ws.onopen = e => this.emit("open", e);
    this.#ws.onerror = e => this.emit("error", e instanceof Error ? e : e.error);
    this.#ws.onclose = e => this.emit("close", e);
  }
  sendPacket(packet) {
    try {
      const stringified = JSON.stringify(packet);
      this.#ws.send(stringified);
    } catch (error) {
      this.emit("error", error);
    }
  }
  destroy() {
    try {
      this.#setHeartbeatInterval(-1);
      this.#ws.close(1000);
    } catch (error) {
      this.emit("error", error);
    }
  }
  #onMessage(event) {
    if (typeof event.data !== "string") return;
    let packet;
    try {
      packet = JSON.parse(event.data);
    } catch (error) {
      this.emit("error", error);
      return;
    }
    if (packet.op === 6) {
      this.#lastHeartbeatAck = Date.now();
      this.#missedHeartbeats = 0;
      this.ping = this.#lastHeartbeatAck - this.#lastHeartbeatSend;
    } else if (packet.op === 8) {
      this.#setHeartbeatInterval(packet.d.heartbeat_interval);
      return;
    }
    this.emit("packet", packet);
  }
  #setHeartbeatInterval(ms) {
    if (typeof this.#heartbeatInterval !== "undefined") clearInterval(this.#heartbeatInterval);
    if (0 < ms)
      this.#heartbeatInterval = setInterval(() => {
        if (this.#lastHeartbeatSend !== 0 && this.#missedHeartbeats >= 3) {
          this.#ws.close();
          this.#setHeartbeatInterval(-1);
        }
        this.#missedHeartbeats++;
        this.sendPacket({ op: 3, d: (this.#lastHeartbeatSend = Date.now()) });
      }, ms);
  }
}

Object.freeze(VoiceWebSocket);
Object.freeze(VoiceWebSocket.prototype);

module.exports = VoiceWebSocket;
