import EventEmitter from "node:events";

export class VoiceWebSocket extends EventEmitter {
  public constructor(address: string);
  public ping: number;
  public sendPacket(packet: { op: number; d: unknown }): void;
  public destroy(): void;
}

export class VoiceUDPSocket extends EventEmitter {
  public constructor(remoteIp: string, remotePort: number);
  public ping: number;
  public readonly remoteIp: string;
  public readonly remotePort: number;
  public send(buffer: Uint8Array | string | ReadonlyArray<any>): void;
  public destroy(): void;
  private performIPDiscovery(ssrc: number): Promise<{
    readonly ip: string;
    readonly port: number;
  }>;
}

export enum NetworkingStatusCode {
  OpeningWs = "OPENING_WS",
  Identifying = "IDENTIFYING",
  UdpHandshaking = "UDP_HANDSHAKING",
  SelectingProtocol = "SELECTING_PROTOCOL",
  Ready = "READY",
  Resuming = "RESUMING",
  Closed = "CLOSED"
}

export enum VoiceOpcode {
  Identify = 0,
  SelectProtocol = 1,
  Ready = 2,
  Heartbeat = 3,
  SessionDescription = 4,
  Speaking = 5,
  HeartbeatAck = 6,
  Resume = 7,
  Hello = 8,
  Resumed = 9,
  ClientConnect = 12,
  ClientDisconnect = 13,
  Codec = 14
}

declare interface ConnectionData {
  ssrc: number;
  encryptionMode: string;
  secretKey: Uint8Array;
  sequence: number;
  timestamp: number;
  nonce: number;
  nonceBuffer: Buffer;
  speaking: boolean;
}

declare interface NetworkingOpeningWsState {
  readonly code: NetworkingStatusCode.OpeningWs;
  readonly ws: VoiceWebSocket;
}

declare interface NetworkingIdentifyingState {
  readonly code: NetworkingStatusCode.Identifying;
  readonly ws: VoiceWebSocket;
}

declare interface NetworkingUdpHandshakingState {
  readonly code: NetworkingStatusCode.UdpHandshaking;
  readonly ws: VoiceWebSocket;
  readonly udp: VoiceUDPSocket;
  readonly connectionData: Pick<ConnectionData, "ssrc">;
}

declare interface NetworkingSelectingProtocolState {
  readonly code: NetworkingStatusCode.SelectingProtocol;
  readonly ws: VoiceWebSocket;
  readonly udp: VoiceUDPSocket;
  readonly connectionData: Pick<ConnectionData, "ssrc">;
}

declare interface NetworkingReadyState {
  readonly code: NetworkingStatusCode.Ready;
  readonly ws: VoiceWebSocket;
  readonly udp: VoiceUDPSocket;
  readonly connectionData: ConnectionData;
}

declare interface NetworkingResumingState {
  readonly code: NetworkingStatusCode.Resuming;
  readonly ws: VoiceWebSocket;
  readonly udp: VoiceUDPSocket;
  readonly connectionData: ConnectionData;
}

declare interface NetworkingClosedState {
  readonly code: NetworkingStatusCode.Closed;
}

declare type NetworkingState =
  | NetworkingOpeningWsState
  | NetworkingIdentifyingState
  | NetworkingUdpHandshakingState
  | NetworkingSelectingProtocolState
  | NetworkingReadyState
  | NetworkingResumingState
  | NetworkingClosedState;

export class Networking extends EventEmitter {
  public constructor(options: { serverId: string; userId: string; sessionId: string; token: string; endpoint: string });
  public readonly serverId: string;
  public readonly userId: string;
  public readonly sessionId: string;
  public readonly token: string;
  public readonly endpoint: string;
  public get state(): NetworkingState;
  public destroy(): void;
  public encryptAudioPacket(opusPacket: Uint8Array): Buffer | undefined;
  public sendEncryptedPacket(buffer: Uint8Array): boolean;
  public setSpeaking(speaking: boolean): void;
  public decryptAudioPacket(buffer: Buffer): Buffer | undefined;
}

export function setEncryptionMethods(methods: {
  open: (buffer: Buffer, nonceBuffer: Buffer, secretKey: Uint8Array) => Uint8Array | null;
  close: (opusPacket: Buffer, nonceBuffer: Buffer, secretKey: Uint8Array) => Uint8Array;
  randomBytes: (number: number, nonceBuffer: Buffer) => Uint8Array;
}): void;
