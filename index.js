const GEMINI_LIVE_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_TRANSLATE_MODEL = "models/gemini-3.5-live-translate-preview";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function closeSocket(socket, code = 1000, reason = "closed") {
  try {
    socket.close(code, reason);
  } catch {
    // Socket is already closed.
  }
}

async function proxyGeminiLive(request, env) {
  // console.log("11111111111");

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "Expected WebSocket upgrade" }, { status: 426 });
  }
  // console.log("111112");
  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
  }
  let setup = {
    model: GEMINI_TRANSLATE_MODEL,
    generationConfig: {
      responseModalities: ['AUDIO'],
      translationConfig: {
        targetLanguageCode: 'en',
        echoTargetLanguage: true
      }
    },
  };
  // console.log("111113");
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  // console.log("111114");
  const geminiWS = new WebSocket(
    `${GEMINI_LIVE_WS}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`
  );
  let setupSent = false;
  let configReceived = false;
  function sendGeminiSetup() {
    if (setupSent || !configReceived || geminiWS.readyState !== WebSocket.OPEN) return;
    setupSent = true;
    // console.log('11111168', setup);
    geminiWS.send(JSON.stringify({ setup }));
  }
  // console.log("111115");
  server.accept();
  // console.log("111116");
  geminiWS.addEventListener('open', () => {
    sendGeminiSetup();
  });
  server.addEventListener("message", (event) => {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    // // console.log('11111167', data);
    if (data.config) {
      const config = data.config;
      // console.log('111111672', config);
      setup.generationConfig.translationConfig.targetLanguageCode = config.targetLanguage || 'en';
      configReceived = true;
      // console.log('111111673', setup);
      sendGeminiSetup();
    } else if (geminiWS.readyState === WebSocket.OPEN && setupSent) {
      geminiWS.send(JSON.stringify(data));
    }
  });
  // console.log("111117");
  geminiWS.addEventListener("message", async (event) => {
    let rawData = event.data;
    if (rawData instanceof Blob) rawData = await rawData.text();
    const message = typeof rawData === 'string' ? JSON.parse(rawData) : event.data;
    // console.log("1111171", message);
    server.send(rawData);
  });
  // console.log("111118");
  server.addEventListener("error", (event) => {
    // console.log("server error", event);
    closeSocket(geminiWS, 1011, "client socket error");
  });
  geminiWS.addEventListener("error", (event) => {
    // console.log("gemini error", event);
    closeSocket(server, 1011, "gemini socket error");
  });
  server.addEventListener("close", (event) => {
    // console.log("server close", event);
    closeSocket(geminiWS);
  });
  geminiWS.addEventListener("close", (event) => {
    // console.log("gemini close", event);
    closeSocket(server);
  });
  // console.log("111119");
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "gemini-live-translate",
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        now: new Date().toISOString(),
      });
    }

    if (url.pathname === "/ws") {
      return proxyGeminiLive(request, env);
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};
