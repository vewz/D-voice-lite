"use strict";

const EventEmitter = require("node:events");
const { createSocket } = require("node:dgram");
const { isIPv4 } = require("node:net");

const KEEP_ALIVE_INTERVAL = 5e3;
const KEEP_ALIVE_LIMIT = 12;
const MAX_COUNTER_VALUE = 2 ** 32 - 1;

class VoiceUDPSocket extends EventEmitter {
  #socket = createSocket("udp4");
  #keepAlives = [];
  #keepAliveCounter = 0;
  #keepAliveBuffer = Buffer.alloc(8);
  #keepAliveInterval = setInterval(() => this.#keepAlive(), KEEP_ALIVE_INTERVAL);
  constructor(remoteIp, remotePort) {
    if (typeof remoteIp !== "string") throw new TypeError("Remote IP must be a string");
    if (typeof remotePort !== "number") throw new TypeError("Remote port must be a number");
    super();
    Object.defineProperty(this, "ping", { value: NaN, writable: true, enumerable: true });
    Object.defineProperty(this, "remoteIp", { value: remoteIp, enumerable: true });
    Object.defineProperty(this, "remotePort", { value: remotePort, enumerable: true });
    this.#socket.on("error", error => this.emit("error", error));
    this.#socket.on("message", buffer => this.#onMessage(buffer));
    this.#socket.on("close", () => this.emit("close"));
    setImmediate(() => this.#keepAlive());
  }
  send(buffer) {
    this.#socket.send(buffer, this.remotePort, this.remoteIp);
  }
  destroy() {
    try {
      this.#socket.close();
    } catch {
      // ignore error
    }
    clearInterval(this.#keepAliveInterval);
  }
  performIPDiscovery(ssrc) {
    return new Promise((resolve, reject) => {
      const listener = message => {
        try {
          if (message.readUInt16BE(0) !== 2) return;
          const packet = Buffer.from(message);
          const ip = packet.slice(8, packet.indexOf(0, 8)).toString("utf-8");
          if (!isIPv4(ip)) throw new Error("Malformed IP address");
          const port = packet.readUInt16BE(packet.length - 2);
          this.#socket.off("message", listener);
          resolve(Object.freeze({ ip, port }));
        } catch {
          // ignore error
        }
      };
      this.#socket.on("message", listener);
      this.#socket.once("close", () => reject(new Error("Cannot perform IP discovery - socket closed")));
      const discoveryBuffer = Buffer.alloc(74);
      discoveryBuffer.writeUInt16BE(1, 0);
      discoveryBuffer.writeUInt16BE(70, 2);
      discoveryBuffer.writeUInt32BE(ssrc, 4);
      this.send(discoveryBuffer);
    });
  }
  #onMessage(buffer) {
    if (buffer.length === 8) {
      const counter = buffer.readUInt32LE(0);
      const index = this.#keepAlives.findIndex(({ value }) => value === counter);
      if (index === -1) return;
      this.ping = Date.now() - this.#keepAlives[index].timestamp;
      this.#keepAlives.splice(0, index);
    }
    this.emit("message", buffer);
  }
  #keepAlive() {
    if (this.#keepAlives.length >= KEEP_ALIVE_LIMIT) {
      this.destroy();
      return;
    }
    this.#keepAliveBuffer.writeUInt32LE(this.#keepAliveCounter, 0);
    this.send(this.#keepAliveBuffer);
    this.#keepAlives.push({
      value: this.#keepAliveCounter,
      timestamp: Date.now()
    });
    this.#keepAliveCounter++;
    if (MAX_COUNTER_VALUE < this.#keepAliveCounter) this.#keepAliveCounter = 0;
  }
}

Object.freeze(VoiceUDPSocket);
Object.freeze(VoiceUDPSocket.prototype);

module.exports = VoiceUDPSocket;
