import sp from "sodium-plus";
import { max_int32bit } from "../../utils.js";
const { SodiumPlus } = sp;

export interface TransportEncryptor {
    encrypt(plaintext: Buffer, additionalData: Buffer): Promise<[Buffer, Buffer]>
}

export class AES256TransportEncryptor implements TransportEncryptor
{
    private _nonce = 0;
    private _secretKey: Promise<CryptoKey>;
    constructor(secretKey: Buffer)
    {
        this._secretKey = crypto.subtle.importKey("raw", 
            secretKey,
            {
                name: "AES-GCM",
                length: 32
            },
            false, ["encrypt"]
        );
    }
    async encrypt(plaintext: Buffer, additionalData: Buffer): Promise<[Buffer, Buffer]> {
        const nonceBuffer = Buffer.alloc(12);
        nonceBuffer.writeUInt32BE(this._nonce);
        this._nonce = (this._nonce + 1) % max_int32bit;
        
        const ciphertext = Buffer.from(await crypto.subtle.encrypt({
            name: "AES-GCM",
            iv: nonceBuffer,
            additionalData,
        }, await this._secretKey, plaintext));

        return [ciphertext, nonceBuffer]
    }
}

export class Chacha20TransportEncryptor implements TransportEncryptor
{
    private static sodium = SodiumPlus.auto();
    private _nonce = 0;
    private _secretKey: sp.CryptographyKey;
    constructor(secretKey: Buffer)
    {
        this._secretKey = new sp.CryptographyKey(secretKey);
    }
    async encrypt(plaintext: Buffer, additionalData: Buffer): Promise<[Buffer, Buffer]> {
        const nonceBuffer = Buffer.alloc(24);
        nonceBuffer.writeUInt32BE(this._nonce);
        this._nonce = (this._nonce + 1) % max_int32bit;

        const ciphertext = await Chacha20TransportEncryptor.sodium
            .then(s => s.crypto_aead_xchacha20poly1305_ietf_encrypt(
                plaintext, nonceBuffer,
                this._secretKey,
                additionalData
            ));

        return [ciphertext, nonceBuffer];
    }
}
