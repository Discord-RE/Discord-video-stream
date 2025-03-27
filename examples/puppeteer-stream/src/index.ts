import { Client, StageChannel } from 'discord.js-selfbot-v13';
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import { executablePath } from 'puppeteer';
import { launch, getStream } from 'puppeteer-stream';
import config from "./config.json" with {type: "json"};

type BrowserOptions = {
    width: number,
    height: number
}

const streamer = new Streamer(new Client());
let browser: Awaited<ReturnType<typeof launch>>;

// ready event
streamer.client.on("ready", () => {
    console.log(`--- ${streamer.client.user?.tag} is ready ---`);
});

let controller: AbortController;

// message event
streamer.client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    if (!config.acceptedAuthors.includes(msg.author.id)) return;

    if (!msg.content) return;

    if (msg.content.startsWith("$play-screen")) {
        const args = msg.content.split(" ");
        if (args.length < 2) return;

        const url = args[1];

        if (!url) return;

        const channel = msg.author.voice?.channel;

        if (!channel) return;

        console.log(`Attempting to join voice channel ${msg.guildId}/${channel.id}`);
        await streamer.joinVoice(msg.guildId!, channel.id);

        if (channel instanceof StageChannel)
        {
            await streamer.client.user?.voice?.setSuppressed(false);
        }

        controller?.abort();
        controller = new AbortController();
        await streamPuppeteer(url, streamer, {
            width: config.streamOpts.width,
            height: config.streamOpts.height
        }, controller.signal);
    } else if (msg.content.startsWith("$disconnect")) {
        controller?.abort();
        streamer.leaveVoice();
    } 
})

// login
streamer.client.login(config.token);

async function streamPuppeteer(url: string, streamer: Streamer, opts: BrowserOptions, cancelSignal?: AbortSignal) {
    cancelSignal?.throwIfAborted();
    cancelSignal?.addEventListener("abort", () => {
        browser.close();
    }, { once: true });
    browser = await launch({
        defaultViewport: {
            width: opts.width,
            height: opts.height,
        },
        executablePath: executablePath()
    });

    const page = await browser.newPage();
    await page.goto(url);

    const stream = await getStream(page, { audio: true, video: true, mimeType: "video/webm;codecs=vp8,opus" }); 

    try {
        const { command, output } = prepareStream(stream, {
            frameRate: config.streamOpts.fps,
            bitrateVideo: config.streamOpts.bitrateKbps,
            bitrateVideoMax: config.streamOpts.maxBitrateKbps,
            hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
            videoCodec: Utils.normalizeVideoCodec(config.streamOpts.videoCodec)
        }, cancelSignal);
        command.on("error", (err, stdout, stderr) => {
            console.log("An error occurred with ffmpeg");
            console.log(err)
        });
        
        await playStream(output, streamer, {
            // Use this to catch up with ffmpeg
            readrateInitialBurst: 10
        }, cancelSignal);
        console.log("Finished playing video");
    } catch (e) {
        console.log(e);
    }
}
