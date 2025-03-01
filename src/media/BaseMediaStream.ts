import { Log } from "debug-level";
import { setTimeout } from "node:timers/promises";
import { Writable } from "node:stream";
import { combineLoHi } from "./utils.js";
import type { Packet } from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";

export class BaseMediaStream extends Writable {
    private _pts?: number;
    private _syncTolerance = 5;
    private _loggerSend: Log;
    private _loggerSync: Log;
    private _loggerSleep: Log;

    private _noSleep: boolean;
    private _startTime?: number;
    private _startPts?: number;
    private _sync = true;

    public syncStream?: BaseMediaStream;
    constructor(type: string, noSleep = false) {
        super({ objectMode: true, highWaterMark: 0 });
        this._loggerSend = new Log(`stream:${type}:send`);
        this._loggerSync = new Log(`stream:${type}:sync`);
        this._loggerSleep = new Log(`stream:${type}:sleep`);
        this._noSleep = noSleep;
    }

    get sync(): boolean {
        return this._sync;
    }
    set sync(val: boolean) {
        this._sync = val;
        if (val)
            this._loggerSync.debug("Sync enabled");
        else
            this._loggerSync.debug("Sync disabled");
    }
    get noSleep(): boolean {
        return this._noSleep;
    }
    set noSleep(val: boolean) {
        this._noSleep = val;
        if (!val)
            this._startPts = this._startTime = undefined;
    }
    get pts(): number | undefined {
        return this._pts;
    }
    get syncTolerance() {
        return this._syncTolerance;
    }
    set syncTolerance(n: number) {
        if (n < 0)
            return;
        this._syncTolerance = n;
    }
    protected async _waitForOtherStream()
    {
        let i = 0;
        while (
            this.sync && this.syncStream &&
            !this.syncStream.writableEnded &&
            this.syncStream.pts !== undefined &&
            this._pts !== undefined &&
            this._pts - this.syncStream.pts > this._syncTolerance
        )
        {
            if (i === 0)
            {
                this._loggerSync.debug(
                    `Waiting for other stream (${this._pts} - ${this.syncStream._pts} > ${this._syncTolerance})`,
                );
            }
            await setTimeout(1);
            i = (i + 1) % 10;
        }
    }
    protected async _sendFrame(frame: Buffer, frametime: number): Promise<void>
    {
        throw new Error("Not implemented");
    }
    async _write(frame: Packet, _: BufferEncoding, callback: (error?: Error | null) => void) {
        await this._waitForOtherStream();

        const { data, ptshi, pts, durationhi, duration, time_base_num, time_base_den } = frame;
        // biome-ignore lint/style/noNonNullAssertion: this will never happen with our media stream
        const frametime = combineLoHi(durationhi!, duration!) / time_base_den! * time_base_num! * 1000;

        const start_sendFrame = performance.now();
        await this._sendFrame(Buffer.from(data), frametime);
        const end_sendFrame = performance.now();

        // biome-ignore lint/style/noNonNullAssertion: this will never happen with our media stream
        this._pts = combineLoHi(ptshi!, pts!) / time_base_den! * time_base_num! * 1000;
        this.emit("pts", this._pts);

        const sendTime = end_sendFrame - start_sendFrame;
        const ratio = sendTime / frametime;
        this._loggerSend.debug({
            stats: {
                pts: this._pts,
                frame_size: data.length,
                duration: sendTime,
                frametime
            }
        }, `Frame sent in ${sendTime.toFixed(2)}ms (${(ratio * 100).toFixed(2)}% frametime)`);
        if (ratio > 1)
        {
            this._loggerSend.warn({
                frame_size: data.length,
                duration: sendTime,
                frametime
            }, `Frame takes too long to send (${(ratio * 100).toFixed(2)}% frametime)`)
        }

        this._startTime ??= start_sendFrame;
        this._startPts ??= this._pts;
        const sleep = Math.max(
            0, this._pts - this._startPts + frametime - (end_sendFrame - this._startTime)
        );
        if (this._noSleep || sleep === 0)
        {
            callback(null);
        }
        else
        {
            this._loggerSleep.debug({
                stats: {
                    pts: this._pts,
                    startPts: this._startPts,
                    time: end_sendFrame,
                    startTime: this._startTime,
                    frametime
                }
            }, `Sleeping for ${sleep}ms`);
            setTimeout(sleep).then(() => callback(null));
        }
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        super._destroy(error, callback);
        this.syncStream = undefined;
    }
}
