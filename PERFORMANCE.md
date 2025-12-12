# Performance related tweaks

## Transport encryption methods

> [!NOTE]
> This is no longer accurate as of [#195](https://github.com/Discord-RE/Discord-video-stream/pull/195), which replaces the custom UDP connection with standard WebRTC. This is kept here for historical purposes only.

On CPUs without AES acceleration (very old x86 CPUs, certain ARM SoCs on single board computers, certain VMs that don't expose AES acceleration capability), the default encryption method (AES-256-GCM) might not be fast enough to handle high frame-rate + high bitrate streams.

In such cases, you can enable the `forceChacha20Encryption` option on the `Streamer` instance (`streamer.opts.forceChacha20Encryption = true`) before starting a stream, to force the use of the faster Chacha20-Poly1305 encryption method. For even higher performance, also install the optional [`sodium-native`](https://www.npmjs.com/package/sodium-native) package to use the faster native version instead of the WASM version.

Below are some benchmark results of the two encryption methods in various circumstances, for reference purposes only. All benchmarks are performed on a Ryzen 5 5600H.

<details>
<summary>AES-256-GCM, with AES acceleration</summary>

```
PS C:\> openssl speed -elapsed -aead -evp aes-256-gcm
You have chosen to measure elapsed time instead of user CPU time.
Doing AES-256-GCM ops for 3s on 2 size blocks: 19046296 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 31 size blocks: 15299030 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 136 size blocks: 13580376 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 1024 size blocks: 7691855 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 8192 size blocks: 1648811 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 16384 size blocks: 863115 AES-256-GCM ops in 3.00s
version: 3.4.0
built on: Tue Oct 22 23:27:41 2024 UTC
options: bn(64,64)
compiler: cl  /Z7 /Fdossl_static.pdb /Gs0 /GF /Gy /MD /W3 /wd4090 /nologo /O2 -DL_ENDIAN -DOPENSSL_PIC -D"OPENSSL_BUILDING_OPENSSL" -D"OPENSSL_SYS_WIN32" -D"WIN32_LEAN_AND_MEAN" -D"UNICODE" -D"_UNICODE" -D"_CRT_SECURE_NO_DEPRECATE" -D"_WINSOCK_DEPRECATED_NO_WARNINGS" -D"NDEBUG" -D_WINSOCK_DEPRECATED_NO_WARNINGS -D_WIN32_WINNT=0x0502
CPUINFO: OPENSSL_ia32cap=0xfed8320b078bffff:0x400684219c97a9
The 'numbers' are in 1000s of bytes per second processed.
type              2 bytes     31 bytes    136 bytes   1024 bytes   8192 bytes  16384 bytes
AES-256-GCM      12693.30k   158089.98k   615233.56k  2625486.51k  4500852.95k  4712187.99k
```

</details>

<details>
<summary>AES-256-GCM, without AES acceleration</summary>

```
PS C:\> openssl speed -elapsed -aead -evp aes-256-gcm
You have chosen to measure elapsed time instead of user CPU time.
Doing AES-256-GCM ops for 3s on 2 size blocks: 6947831 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 31 size blocks: 4875037 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 136 size blocks: 3132696 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 1024 size blocks: 821006 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 8192 size blocks: 113769 AES-256-GCM ops in 3.00s
Doing AES-256-GCM ops for 3s on 16384 size blocks: 57074 AES-256-GCM ops in 3.00s
version: 3.4.0
built on: Tue Oct 22 23:27:41 2024 UTC
options: bn(64,64)
compiler: cl  /Z7 /Fdossl_static.pdb /Gs0 /GF /Gy /MD /W3 /wd4090 /nologo /O2 -DL_ENDIAN -DOPENSSL_PIC -D"OPENSSL_BUILDING_OPENSSL" -D"OPENSSL_SYS_WIN32" -D"WIN32_LEAN_AND_MEAN" -D"UNICODE" -D"_UNICODE" -D"_CRT_SECURE_NO_DEPRECATE" -D"_WINSOCK_DEPRECATED_NO_WARNINGS" -D"NDEBUG" -D_WINSOCK_DEPRECATED_NO_WARNINGS -D_WIN32_WINNT=0x0502
CPUINFO: OPENSSL_ia32cap=0xfcd83209078bffff:0x0 env:~0x200000200000000
The 'numbers' are in 1000s of bytes per second processed.
type              2 bytes     31 bytes    136 bytes   1024 bytes   8192 bytes  16384 bytes
AES-256-GCM       4630.34k    50358.60k   142015.55k   280143.33k   310561.70k   311596.27k
```

</details>

<details>
<summary>Chacha20-Poly1305</summary>

```
PS C:\> openssl speed -elapsed -aead -evp chacha20-poly1305
You have chosen to measure elapsed time instead of user CPU time.
Doing ChaCha20-Poly1305 ops for 3s on 2 size blocks: 8312139 ChaCha20-Poly1305 ops in 3.00s
Doing ChaCha20-Poly1305 ops for 3s on 31 size blocks: 7801222 ChaCha20-Poly1305 ops in 3.00s
Doing ChaCha20-Poly1305 ops for 3s on 136 size blocks: 5436377 ChaCha20-Poly1305 ops in 3.00s
Doing ChaCha20-Poly1305 ops for 3s on 1024 size blocks: 4182141 ChaCha20-Poly1305 ops in 3.00s
Doing ChaCha20-Poly1305 ops for 3s on 8192 size blocks: 903567 ChaCha20-Poly1305 ops in 3.00s
Doing ChaCha20-Poly1305 ops for 3s on 16384 size blocks: 472556 ChaCha20-Poly1305 ops in 3.00s
version: 3.4.0
built on: Tue Oct 22 23:27:41 2024 UTC
options: bn(64,64)
compiler: cl  /Z7 /Fdossl_static.pdb /Gs0 /GF /Gy /MD /W3 /wd4090 /nologo /O2 -DL_ENDIAN -DOPENSSL_PIC -D"OPENSSL_BUILDING_OPENSSL" -D"OPENSSL_SYS_WIN32" -D"WIN32_LEAN_AND_MEAN" -D"UNICODE" -D"_UNICODE" -D"_CRT_SECURE_NO_DEPRECATE" -D"_WINSOCK_DEPRECATED_NO_WARNINGS" -D"NDEBUG" -D_WINSOCK_DEPRECATED_NO_WARNINGS -D_WIN32_WINNT=0x0502
CPUINFO: OPENSSL_ia32cap=0xfed8320b078bffff:0x400684219c97a9
The 'numbers' are in 1000s of bytes per second processed.
type              2 bytes     31 bytes    136 bytes   1024 bytes   8192 bytes  16384 bytes
ChaCha20-Poly1305     5539.58k    80585.77k   246284.90k  1427504.13k  2465696.49k  2580785.83k
```

</details>
