// Module imports
import { Networking, NetworkingStatusCode, setEncryptionMethods } from ".";
import { BaseGuildVoiceChannel, Client, Intents } from "discord.js";
import { FFmpeg, opus } from "prism-media";
import { createReadStream } from "node:fs";
import tweetnacl from "tweetnacl";

setEncryptionMethods({
  open: tweetnacl.secretbox.open,
  close: tweetnacl.secretbox,
  randomBytes: tweetnacl.randomBytes
});

// Interface declarations
interface DiscordGatewayAdapter {
  sendPayload(payload: unknown): boolean;
  destroy(): void;
}

// Constants definitions
const client = new Client({
  intents: Object.values(Intents.FLAGS)
});

const audioStream = createReadStream("test2.mp3")
  .pipe(new FFmpeg({ args: ["-analyzeduration", "0", "-loglevel", "0", "-f", "s16le", "-ar", "48000", "-ac", "2"] }))
  .pipe(new opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 }));

const opusPacketsPromise = new Promise<Buffer[]>(resolve => {
  const packets: Buffer[] = [];
  audioStream.on("data", d => packets.push(d));
  audioStream.on("end", () => resolve(packets));
});

// Ready Event Handler (Discord.js)
console.time("[DEBUG] client ready");
client.once("ready", async () => {
  console.timeEnd("[DEBUG] client ready");

  // Get a voice channel
  const channel = client.channels.cache.get("970331022921179136");
  if (!channel?.isVoice()) throw new Error("The channel is not a voice channel");

  // Get authentication information for Discord Voice Gateway
  console.debug("[DEBUG] fetching auth info for Voice Gateway");
  console.time("[DEBUG] voice auth info");
  const { options } = await fetchVoiceGatewayInfo(channel);
  console.timeEnd("[DEBUG] voice auth info");

  // Connect to Discord Voice Gateway and RTP connection
  console.debug("[DEBUG] connecting to Voice Gateway");
  console.time("[DEBUG] voice gateway");
  const networking = new Networking(options);
  networking.on("stateChange", () => {
    console.log(
      require("util").inspect(networking, { colors: true, depth: Infinity, showHidden: true }),
      require("util").inspect(networking.state, { colors: true, depth: Infinity, showHidden: true })
    );
  });

  // Wait for the RTP connection to be ready
  if (networking.state.code !== NetworkingStatusCode.Ready) {
    await new Promise(r => networking.once(NetworkingStatusCode.Ready, r));
  }
  console.timeEnd("[DEBUG] voice gateway");

  // Wait for opus encoding
  console.time("[DEBUG] opus packets");
  const opusPackets = await opusPacketsPromise;
  console.timeEnd("[DEBUG] opus packets");

  // Send an audio stream to Discord
  let next = Date.now();
  let preparedPacket: Uint8Array | undefined;
  function audioCycleStep() {
    next += 20;
    if (preparedPacket) networking.sendEncryptedPacket(preparedPacket);
    const packet = opusPackets.shift() as Buffer;
    opusPackets.push(packet);
    preparedPacket = networking.encryptAudioPacket(packet);
    setTimeout(audioCycleStep, next - Date.now());
  }
  setImmediate(audioCycleStep);
});

// Login to Discord
client.login();

// Function definitions
function fetchVoiceGatewayInfo(vc: BaseGuildVoiceChannel) {
  return new Promise<{
    options: {
      endpoint: string;
      serverId: string;
      token: string;
      sessionId: string;
      userId: string;
    };
    adapter: DiscordGatewayAdapter;
  }>((resolve, reject) => {
    let statePackets: any;
    const adapter = vc.guild.voiceAdapterCreator({
      onVoiceServerUpdate(data) {
        if (typeof data.endpoint !== "string") return reject(new Error("Invalid endpoint"));
        if (typeof statePackets?.session_id !== "string") return reject(new Error("Session ID is missing"));
        if (typeof statePackets?.user_id !== "string") return reject(new Error("User ID is missing"));
        resolve({
          options: {
            endpoint: data.endpoint,
            serverId: data.guild_id,
            token: data.token,
            sessionId: statePackets.session_id,
            userId: statePackets.user_id
          },
          adapter
        });
      },
      onVoiceStateUpdate: d => (statePackets = d),
      destroy() {}
    });
    adapter.sendPayload({
      op: 4,
      d: {
        guild_id: vc.guildId,
        channel_id: vc.id,
        self_deaf: false,
        self_mute: false
      }
    });
  });
}
