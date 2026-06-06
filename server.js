const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const cookieParser = require("cookie-parser");
const express = require("express");
const helmet = require("helmet");
const NodeMediaServer = require("node-media-server");

function loadEnvFile() {
    const envFile = path.join(__dirname, ".env");
    if (!fs.existsSync(envFile)) return;

    const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1) continue;

        const key = trimmed.slice(0, separatorIndex).trim();
        const rawValue = trimmed.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^["']|["']$/g, "");

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadEnvFile();

const WEB_PORT = Number(process.env.PORT || 6789);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HOSTNAME = process.env.PUBLIC_HOST || null;
const DASHBOARD_PASSWORD = process.env.STREAM_PASSWORD || "stream@pallabdev";
const COOKIE_SECRET = process.env.COOKIE_SECRET || "change-this-cookie-secret";
const HLS_VIDEO_MODE = process.env.HLS_VIDEO_MODE || "transcode";
const HLS_VIDEO_BITRATE = process.env.HLS_VIDEO_BITRATE || "2800k";
const HLS_AUDIO_BITRATE = process.env.HLS_AUDIO_BITRATE || "128k";

const rootDir = __dirname;
const mediaDir = path.join(rootDir, "media");
const keyFile = path.join(rootDir, ".stream-key");

fs.mkdirSync(mediaDir, { recursive: true });

function resolveFfmpegPath() {
    const candidates = [
        process.env.FFMPEG_PATH,
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        "/usr/bin/ffmpeg",
        "/usr/local/bin/ffmpeg"
    ].filter(Boolean);

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    return found || process.env.FFMPEG_PATH || "ffmpeg";
}

const FFMPEG_PATH = resolveFfmpegPath();

function loadStreamKey() {
    if (process.env.STREAM_KEY) return process.env.STREAM_KEY;
    if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();

    const key = `live-${crypto.randomBytes(9).toString("hex")}`;
    fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    return key;
}

const STREAM_KEY = loadStreamKey();
const hlsProcesses = new Map();

function getStreamDir(streamName = STREAM_KEY) {
    return path.join(mediaDir, "rtmp", streamName);
}

function getHlsFile(streamName = STREAM_KEY) {
    return path.join(getStreamDir(streamName), "index.m3u8");
}

function cleanStreamFiles(streamName) {
    const dir = getStreamDir(streamName);
    fs.mkdirSync(dir, { recursive: true });

    for (const file of fs.readdirSync(dir)) {
        if (file.endsWith(".m3u8") || file.endsWith(".ts") || file.endsWith(".tmp")) {
            fs.rmSync(path.join(dir, file), { force: true });
        }
    }
}

function startHls(streamPath) {
    const parts = streamPath.split("/");
    const streamName = parts[2];
    if (!streamName || hlsProcesses.has(streamName)) return;

    cleanStreamFiles(streamName);

    const outputFile = getHlsFile(streamName);
    const inputUrl = `rtmp://127.0.0.1:${RTMP_PORT}${streamPath}`;
    const videoArgs =
        HLS_VIDEO_MODE === "copy"
            ? ["-c:v", "copy"]
            : [
                  "-c:v",
                  "libx264",
                  "-preset",
                  "ultrafast",
                  "-tune",
                  "zerolatency",
                  "-profile:v",
                  "main",
                  "-level",
                  "4.0",
                  "-pix_fmt",
                  "yuv420p",
                  "-vf",
                  "scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30",
                  "-b:v",
                  HLS_VIDEO_BITRATE,
                  "-maxrate",
                  HLS_VIDEO_BITRATE,
                  "-bufsize",
                  "5600k",
                  "-g",
                  "60",
                  "-keyint_min",
                  "60",
                  "-sc_threshold",
                  "0"
              ];

    const args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        inputUrl,
        ...videoArgs,
        "-c:a",
        "aac",
        "-b:a",
        HLS_AUDIO_BITRATE,
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "hls",
        "-hls_time",
        "6",
        "-hls_list_size",
        "8",
        "-hls_delete_threshold",
        "8",
        "-hls_allow_cache",
        "0",
        "-hls_flags",
        "delete_segments+omit_endlist+independent_segments",
        "-hls_segment_filename",
        path.join(getStreamDir(streamName), "segment-%05d.ts"),
        outputFile
    ];

    console.log(`[hls] starting ffmpeg for ${streamPath}`);
    console.log(`[hls] video mode ${HLS_VIDEO_MODE}`);
    console.log(`[hls] input ${inputUrl}`);
    console.log(`[hls] output ${outputFile}`);

    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    hlsProcesses.set(streamName, child);

    child.stderr.on("data", (data) => {
        console.log(`[ffmpeg:${streamName}] ${data.toString().trim()}`);
    });

    child.on("error", (error) => {
        console.error(`[hls] ffmpeg failed for ${streamName}: ${error.message}`);
    });

    child.on("close", (code, signal) => {
        hlsProcesses.delete(streamName);
        console.log(`[hls] ffmpeg stopped for ${streamName} code=${code} signal=${signal || "none"}`);
    });
}

function stopHls(streamPath) {
    const streamName = streamPath.split("/")[2];
    const child = hlsProcesses.get(streamName);
    if (!child) return;

    console.log(`[hls] stopping ffmpeg for ${streamPath}`);
    child.kill("SIGTERM");
}

const app = express();
app.disable("x-powered-by");
app.use(
    helmet({
        contentSecurityPolicy: false
    })
);
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser(COOKIE_SECRET));
app.use("/assets", express.static(path.join(rootDir, "public")));

app.get("/health", (req, res) => {
    const hlsFile = getHlsFile();
    res.json({
        ok: true,
        webPort: WEB_PORT,
        rtmpPort: RTMP_PORT,
        streamKey: STREAM_KEY,
        ffmpegPath: FFMPEG_PATH,
        hlsRunning: hlsProcesses.has(STREAM_KEY),
        hlsReady: fs.existsSync(hlsFile),
        hlsPath: `/hls/rtmp/${STREAM_KEY}/index.m3u8`
    });
});

app.use(
    "/hls",
    express.static(mediaDir, {
        setHeaders(res, filePath) {
            if (filePath.endsWith(".m3u8")) res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            if (filePath.endsWith(".ts")) res.setHeader("Content-Type", "video/mp2t");
            res.setHeader("Cache-Control", "no-store");
        }
    })
);

app.get("/hls/rtmp/:streamKey/index.m3u8", (req, res) => {
    if (req.params.streamKey !== STREAM_KEY) {
        return res.status(404).type("text/plain").send("Unknown stream key. Open /dashboard for the current key.");
    }

    return res
        .status(404)
        .type("text/plain")
        .send("HLS is not ready yet. Start streaming with H.264 video and AAC audio, then wait a few seconds.");
});

app.get("/hls/rtmp/:streamKey/:segment", (req, res) => {
    if (req.params.streamKey !== STREAM_KEY || !req.params.segment.endsWith(".ts")) {
        return res.status(404).type("text/plain").send("Not found.");
    }

    return res
        .status(404)
        .type("text/plain")
        .send("This live HLS segment is no longer available. Refresh /play to load the current playlist.");
});

function isLoggedIn(req) {
    return req.signedCookies.stream_admin === "ok";
}

function requireLogin(req, res, next) {
    if (isLoggedIn(req)) return next();
    return res.redirect("/");
}

function hostFromRequest(req) {
    const forwardedHost = req.get("x-forwarded-host");
    return HOSTNAME || forwardedHost || req.get("host") || `localhost:${WEB_PORT}`;
}

function rtmpHostFromRequest(req) {
    const host = hostFromRequest(req).split(":")[0];
    return `${host}:${RTMP_PORT}`;
}

function renderPage({ title, body, extraHead = "" }) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/assets/styles.css">
  ${extraHead}
</head>
<body>
  ${body}
</body>
</html>`;
}

app.get("/", (req, res) => {
    if (isLoggedIn(req)) return res.redirect("/dashboard");

    res.send(
        renderPage({
            title: "Stream Login",
            body: `<main class="auth-shell">
  <section class="login-panel">
    <p class="eyebrow">Private stream control</p>
    <h1>PallabDev Live</h1>
    <form method="post" action="/login" class="login-form">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Enter</button>
    </form>
    ${req.query.error ? `<p class="error">Wrong password.</p>` : ""}
  </section>
</main>`
        })
    );
});

app.post("/login", (req, res) => {
    if (req.body.password !== DASHBOARD_PASSWORD) return res.redirect("/?error=1");

    res.cookie("stream_admin", "ok", {
        signed: true,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 8
    });
    return res.redirect("/dashboard");
});

app.post("/logout", (req, res) => {
    res.clearCookie("stream_admin");
    res.redirect("/");
});

app.get("/dashboard", requireLogin, (req, res) => {
    const webHost = hostFromRequest(req);
    const protocol = req.get("x-forwarded-proto") || req.protocol;
    const rtmpUrl = `rtmp://${rtmpHostFromRequest(req)}/rtmp`;
    const hlsUrl = `${protocol}://${webHost}/hls/rtmp/${STREAM_KEY}/index.m3u8`;
    const playUrl = `${protocol}://${webHost}/play`;

    res.send(
        renderPage({
            title: "Stream Dashboard",
            body: `<main class="dashboard">
  <header class="topbar">
    <div>
      <p class="eyebrow">RTMP to HLS</p>
      <h1>Stream Dashboard</h1>
    </div>
    <form method="post" action="/logout"><button class="ghost" type="submit">Logout</button></form>
  </header>

  <section class="grid">
    <article class="panel">
      <h2>OBS settings</h2>
      <label>Server</label>
      <code>${rtmpUrl}</code>
      <label>Stream key</label>
      <code>${STREAM_KEY}</code>
    </article>

    <article class="panel">
      <h2>Viewer links</h2>
      <label>Play page</label>
      <code>${playUrl}</code>
      <label>Direct HLS</label>
      <code>${hlsUrl}</code>
    </article>

    <article class="panel wide">
      <h2>Recommended encoder</h2>
      <div class="specs">
        <span>1280x720</span>
        <span>30 FPS</span>
        <span>H.264 required</span>
        <span>AAC</span>
        <span>2500-3500 Kbps</span>
        <span>Keyframe 2s</span>
      </div>
    </article>
  </section>
</main>`
        })
    );
});

app.get("/play", (req, res) => {
    const hlsPath = `/hls/rtmp/${STREAM_KEY}/index.m3u8`;
    res.send(
        renderPage({
            title: "Live Stream",
            extraHead: `<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js"></script>`,
            body: `<main class="player-shell">
  <header>
    <p class="eyebrow">Live now</p>
    <h1>PallabDev Stream</h1>
  </header>
  <video id="video" controls autoplay muted playsinline preload="auto"></video>
  <p id="status" class="status">Waiting for stream...</p>
</main>
<script>
const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const src = "${hlsPath}";
let retryTimer = null;
let hls = null;

function setStatus(text) {
  statusEl.textContent = text;
}

async function checkManifest() {
  try {
    const response = await fetch(src + "?t=" + Date.now(), { cache: "no-store" });
    return response.ok;
  } catch (_) {
    return false;
  }
}

function tryPlay() {
  video.play().catch(() => {
    setStatus("Click play to start the live stream.");
  });
}

function retrySoon() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    startPlayer();
  }, 2500);
}

async function startPlayer() {
  const ready = await checkManifest();
  if (!ready) {
    setStatus("Waiting for HLS playlist...");
    retrySoon();
    return;
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = src + "?t=" + Date.now();
    video.addEventListener("loadedmetadata", () => {
      setStatus("Stream is live.");
      tryPlay();
    }, { once: true });
    video.addEventListener("error", () => {
      setStatus("Native HLS failed. Retrying...");
      retrySoon();
    }, { once: true });
    return;
  }

  if (!window.Hls || !Hls.isSupported()) {
    setStatus("HLS.js is not available in this browser.");
    return;
  }

  if (hls) hls.destroy();
  hls = new Hls({
    enableWorker: true,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
    maxBufferLength: 12,
    backBufferLength: 30,
    lowLatencyMode: false
  });

  hls.attachMedia(video);
  hls.on(Hls.Events.MEDIA_ATTACHED, () => {
    hls.loadSource(src + "?t=" + Date.now());
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    setStatus("Stream is live.");
    tryPlay();
  });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      setStatus("HLS network error. Retrying...");
      retrySoon();
      return;
    }

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      setStatus("Media error. Recovering...");
      hls.recoverMediaError();
      return;
    }

    setStatus("HLS player failed. Restart the stream and refresh.");
    hls.destroy();
    hls = null;
  });
}

startPlayer();
</script>`
        })
    );
});

const nms = new NodeMediaServer({
    logType: 2,
    rtmp: {
        port: RTMP_PORT,
        chunk_size: 60000,
        gop_cache: false,
        ping: 30,
        ping_timeout: 60
    },
    http: {
        port: Number(process.env.NMS_HTTP_PORT || 8001),
        mediaroot: mediaDir,
        allow_origin: "*"
    }
});

nms.on("prePublish", (id, streamPath, args) => {
    const session = nms.getSession(id);
    const parts = streamPath.split("/");
    const streamName = parts[2];

    if (parts[1] !== "rtmp" || streamName !== STREAM_KEY) {
        session.reject();
    }
});

nms.on("postPublish", (id, streamPath) => {
    startHls(streamPath);
});

nms.on("donePublish", (id, streamPath) => {
    stopHls(streamPath);
});

nms.run();

app.listen(WEB_PORT, () => {
    console.log(`Dashboard: http://localhost:${WEB_PORT}`);
    console.log(`RTMP ingest: rtmp://localhost:${RTMP_PORT}/rtmp`);
    console.log(`Stream key: ${STREAM_KEY}`);
    console.log(`FFmpeg: ${FFMPEG_PATH}`);
    console.log("OBS must stream H.264 video + AAC audio. H.265/HEVC will not play in this low-CPU HLS mode.");
});
