# RTMP HLS Streaming Server

Small Node server for one private RTMP ingest and HLS playback.

## Requirements

- Node.js 18+
- FFmpeg installed and available as `ffmpeg`
- Open ports:
  - `6789` for the web dashboard and player
  - `1935` for RTMP ingest

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open:

```text
http://localhost:6789
```

Dashboard password:

```text
stream@pallabdev
```

The dashboard shows:

- RTMP server URL: `rtmp://your-host:1935/rtmp`
- Stream key
- Viewer page: `/play`
- Direct HLS URL
- Health check: `/health`

## OBS Settings

Use these settings for a low-resource 1 vCPU / 2 GB RAM server:

- Output mode: Advanced
- Encoder: hardware H.264 if available, otherwise x264 veryfast
- Resolution: `1280x720`
- FPS: `30`
- Video bitrate: `2500-3500 Kbps`
- Keyframe interval: `2 seconds`
- Audio codec: AAC
- Audio bitrate: `128 Kbps`

The server copies the incoming H.264/AAC stream into HLS, so OBS does the heavy encoding work.
Do not use H.265/HEVC for this setup. Browser HLS playback will fail and `index.m3u8` may not be created.

## Environment Variables

```text
PORT=6789
RTMP_PORT=1935
NMS_HTTP_PORT=8001
PUBLIC_HOST=your-domain.com
STREAM_PASSWORD=stream@pallabdev
STREAM_KEY=optional-fixed-stream-key
COOKIE_SECRET=replace-with-a-long-random-value
FFMPEG_PATH=ffmpeg
```

If `STREAM_KEY` is not set, the app creates one in `.stream-key` on first run.
