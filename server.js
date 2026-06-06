const crypto = require("crypto");
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
    const hlsFile = path.join(mediaDir, "rtmp", STREAM_KEY, "index.m3u8");
    res.json({
        ok: true,
        webPort: WEB_PORT,
        rtmpPort: RTMP_PORT,
        streamKey: STREAM_KEY,
        ffmpegPath: FFMPEG_PATH,
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
            extraHead: `<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>`,
            body: `<main class="player-shell">
  <header>
    <p class="eyebrow">Live now</p>
    <h1>PallabDev Stream</h1>
  </header>
  <video id="video" controls autoplay muted playsinline></video>
  <p id="status" class="status">Waiting for stream...</p>
</main>
<script>
const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const src = "${hlsPath}";
let retryTimer = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function retrySoon(hls) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    setStatus("Waiting for H.264/AAC stream...");
    hls.loadSource(src + "?t=" + Date.now());
  }, 2500);
}

if (video.canPlayType("application/vnd.apple.mpegurl")) {
  video.src = src;
  video.addEventListener("loadedmetadata", () => setStatus("Stream is live."));
  video.addEventListener("error", () => setStatus("Waiting for H.264/AAC stream..."));
} else if (window.Hls && Hls.isSupported()) {
  const hls = new Hls({
    liveSyncDurationCount: 3,
    maxBufferLength: 12,
    lowLatencyMode: false
  });
  hls.loadSource(src);
  hls.attachMedia(video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => setStatus("Stream is live."));
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) retrySoon(hls);
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
  });
} else {
  setStatus("This browser does not support HLS playback.");
}
</script>`
        })
    );
});

const nms = new NodeMediaServer({
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
    },
    trans: {
        ffmpeg: FFMPEG_PATH,
        tasks: [
            {
                app: "rtmp",
                hls: true,
                hlsFlags: "[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list+omit_endlist]",
                ac: "copy",
                vc: "copy",
                acParam: [],
                vcParam: []
            }
        ]
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

nms.run();

app.listen(WEB_PORT, () => {
    console.log(`Dashboard: http://localhost:${WEB_PORT}`);
    console.log(`RTMP ingest: rtmp://localhost:${RTMP_PORT}/rtmp`);
    console.log(`Stream key: ${STREAM_KEY}`);
    console.log(`FFmpeg: ${FFMPEG_PATH}`);
    console.log("OBS must stream H.264 video + AAC audio. H.265/HEVC will not play in this low-CPU HLS mode.");
});
