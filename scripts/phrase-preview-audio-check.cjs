const { app, BrowserWindow, ipcMain } = require("electron");

const targetMs = Number(process.env.LATENCY_TARGET_MS || 500);
const warmFirst = process.env.PHRASE_AUDIO_WARM !== "0";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("no-sandbox");

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  let done = false;
  const timeout = setTimeout(() => {
    done = true;
    win.destroy();
    console.error("FAIL: speech synthesis did not start.");
    app.exit(3);
  }, Number(process.env.PHRASE_AUDIO_TIMEOUT_MS || 5000));

  ipcMain.once("speech-started", (_event, elapsedMs) => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timeout);
    win.destroy();
    console.log(`phrase preview audio started in ${elapsedMs} ms`);
    if (elapsedMs > targetMs) {
      console.error(`FAIL: speech synthesis exceeded ${targetMs} ms.`);
    }
    app.exit(elapsedMs <= targetMs ? 0 : 3);
  });

  ipcMain.once("speech-error", (_event, message) => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timeout);
    win.destroy();
    console.error(`FAIL: ${message}`);
    app.exit(3);
  });

  await win.loadURL(`data:text/html,${encodeURIComponent(renderPage(warmFirst))}`);
});

function renderPage(warm) {
  return `<!doctype html>
<html>
<body>
<script>
const { ipcRenderer } = require("electron");
const warmFirst = ${JSON.stringify(warm)};
if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
  ipcRenderer.send("speech-error", "speech synthesis is unavailable");
} else {
  if (warmFirst) {
    const warmup = new SpeechSynthesisUtterance(".");
    warmup.volume = 0;
    warmup.onend = speakMeasured;
    warmup.onerror = speakMeasured;
    window.speechSynthesis.speak(warmup);
  } else {
    speakMeasured();
  }
}

function speakMeasured() {
  const startedAt = Date.now();
  const utterance = new SpeechSynthesisUtterance("thank you");
  utterance.lang = "en-US";
  utterance.onstart = () => {
    ipcRenderer.send("speech-started", Date.now() - startedAt);
  };
  utterance.onerror = (event) => {
    ipcRenderer.send("speech-error", event.error || "speech synthesis failed");
  };
  window.speechSynthesis.speak(utterance);
}
</script>
</body>
</html>`;
}
