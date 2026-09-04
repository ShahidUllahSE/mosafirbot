/**
 * Mosafir WhatsApp Relay
 * Forwards text + media to teammate webhook; sends replies via API.
 */
require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const qrcode = require('qrcode');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const log = require('./logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const authFolder = path.join(__dirname, 'baileys_auth');
const qrFolder = path.join(__dirname, 'qrcodes');
const jidMapFile = path.join(__dirname, 'jid_map.json');

fs.ensureDirSync(qrFolder);
fs.ensureDirSync(authFolder);

let sock = null;
let baileysLogger = null;
let currentQr = '';
let isConnected = false;
let isStarting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;

// phone (digits) <-> WhatsApp jid (@lid or @s.whatsapp.net)
const phoneToJidMap = new Map();
const jidToPhoneMap = new Map();

function loadJidMap() {
  try {
    if (!fs.existsSync(jidMapFile)) return;
    const data = fs.readJsonSync(jidMapFile);
    for (const [phone, jid] of Object.entries(data.phoneToJid || {})) {
      phoneToJidMap.set(phone, jid);
      jidToPhoneMap.set(jid, phone);
    }
  } catch (e) {
    log.warn('⚠️ Could not load jid map:', e.message);
  }
}

function saveJidMap() {
  try {
    fs.writeJsonSync(jidMapFile, {
      phoneToJid: Object.fromEntries(phoneToJidMap),
    });
  } catch (e) {
    log.warn('⚠️ Could not save jid map:', e.message);
  }
}

function stripJidToDigits(jid) {
  return (jid || '').replace(/@(c\.us|s\.whatsapp\.net|lid)$/g, '');
}

function isPhoneJid(jid) {
  return jid?.endsWith('@s.whatsapp.net') || jid?.endsWith('@c.us');
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || null;
}

function registerMapping(phone, jid) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || !jid) return;

  phoneToJidMap.set(normalizedPhone, jid);
  jidToPhoneMap.set(jid, normalizedPhone);
  saveJidMap();
}

function phoneFromPn(pn) {
  if (!pn) return null;
  if (pn.includes('@')) return stripJidToDigits(pn);
  return normalizePhone(pn);
}

function resolveIncomingIdentity(msg, jid) {
  let phone =
    phoneFromPn(msg.key?.senderPn) ||
    phoneFromPn(msg.key?.participantPn) ||
    jidToPhoneMap.get(jid) ||
    (isPhoneJid(jid) ? stripJidToDigits(jid) : null);

  if (phone) {
    registerMapping(phone, jid);
  }

  return {
    jid,
    phone: phone || stripJidToDigits(jid),
  };
}

function phoneForJid(jid) {
  return jidToPhoneMap.get(jid) || (isPhoneJid(jid) ? stripJidToDigits(jid) : null);
}

function toRecipientJid(to) {
  const value = String(to || '').trim();
  if (!value) return null;

  // Full jid (e.g. 125507618234380@lid) — still supported
  if (value.includes('@')) {
    const phone = phoneForJid(value) || (isPhoneJid(value) ? stripJidToDigits(value) : null);
    if (phone) registerMapping(phone, value);
    return value;
  }

  const digits = normalizePhone(value);
  if (!digits) return null;

  // Use mapped jid when teammate sends phone number
  if (phoneToJidMap.has(digits)) {
    return phoneToJidMap.get(digits);
  }

  return `${digits}@s.whatsapp.net`;
}

loadJidMap();

if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

function jidToPhone(jid) {
  return phoneForJid(jid) || stripJidToDigits(jid);
}

function isAuthorized(req, res) {
  const apiKey = process.env.REPLY_API_KEY;
  if (!apiKey) return true;

  const provided =
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (provided !== apiKey) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function requireWhatsApp(req, res) {
  if (!isAuthorized(req, res)) return false;
  if (!isConnected || !sock) {
    res.status(503).json({ ok: false, error: 'WhatsApp is not connected' });
    return false;
  }
  return true;
}

function parseJidFromBody(req, res) {
  const { to, jid } = req.body || {};
  const recipient = toRecipientJid(jid || to);
  if (!recipient) {
    res.status(400).json({ ok: false, error: 'Invalid or missing recipient (to or jid)' });
    return null;
  }
  return recipient;
}

async function forwardToTeammate(payload) {
  const url = process.env.TEAMMATE_WEBHOOK_URL;
  if (!url) {
    log.warn('⚠️ TEAMMATE_WEBHOOK_URL not set — message not forwarded');
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.WEBHOOK_SECRET) {
    headers['X-Webhook-Secret'] = process.env.WEBHOOK_SECRET;
    headers.Authorization = `Bearer ${process.env.WEBHOOK_SECRET}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Webhook returned ${response.status}: ${body}`);
  }
}

function uploadToCloudinary(buffer, resourceType = 'auto') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'mosafir/whatsapp', resource_type: resourceType },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

async function downloadWhatsAppMedia(msg) {
  const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
  return downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }
  );
}

async function fetchMediaBuffer(mediaUrl) {
  const response = await fetch(mediaUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function detectIncomingMessage(msgContent) {
  if (msgContent.conversation || msgContent.extendedTextMessage?.text) {
    const text = msgContent.conversation || msgContent.extendedTextMessage?.text || '';
    if (text.trim()) {
      return { webhookType: 'text', text: text.trim() };
    }
  }

  if (msgContent.imageMessage) {
    return {
      webhookType: 'image',
      mimeType: msgContent.imageMessage.mimetype || 'image/jpeg',
      caption: msgContent.imageMessage.caption || '',
    };
  }

  if (msgContent.audioMessage) {
    return {
      webhookType: 'voice',
      mimeType: msgContent.audioMessage.mimetype || 'audio/ogg; codecs=opus',
      duration: msgContent.audioMessage.seconds || null,
    };
  }

  if (msgContent.videoMessage) {
    return {
      webhookType: 'video',
      mimeType: msgContent.videoMessage.mimetype || 'video/mp4',
      caption: msgContent.videoMessage.caption || '',
      duration: msgContent.videoMessage.seconds || null,
    };
  }

  if (msgContent.documentMessage) {
    return {
      webhookType: 'document',
      mimeType: msgContent.documentMessage.mimetype || 'application/octet-stream',
      fileName: msgContent.documentMessage.fileName || 'document',
      caption: msgContent.documentMessage.caption || '',
    };
  }

  return null;
}

async function processIncomingMessage(msg, jid) {
  const msgContent = msg.message;
  if (!msgContent) return;

  const detected = detectIncomingMessage(msgContent);
  if (!detected) return;

  const identity = resolveIncomingIdentity(msg, jid);

  const basePayload = {
    type: detected.webhookType,
    jid: identity.jid,
    from: identity.phone,
    to: process.env.COMPANY_WHATSAPP_NUMBER || null,
    profileName: String(msg.pushName || '').trim() || null,
    messageId: msg.key.id || null,
    timestamp: Number(msg.messageTimestamp) || Date.now(),
  };

  if (detected.webhookType === 'text') {
    await forwardToTeammate({ ...basePayload, text: detected.text });
    log.success('✅ Text forwarded from', basePayload.from);
    return;
  }

  const buffer = await downloadWhatsAppMedia(msg);
  const upload = await uploadToCloudinary(buffer, 'auto');

  const payload = {
    ...basePayload,
    mediaUrl: upload.secure_url,
    mimeType: detected.mimeType,
    caption: detected.caption || '',
  };

  if (detected.fileName) payload.fileName = detected.fileName;
  if (detected.duration != null) payload.duration = detected.duration;

  await forwardToTeammate(payload);
  log.success('✅', detected.webhookType, 'forwarded from', basePayload.from);
}

function endSocket() {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    sock.end?.(undefined);
  } catch (_) {
    // ignore teardown errors
  }
  sock = null;
}

function clearAuthFolder() {
  try {
    if (fs.existsSync(authFolder)) {
      fs.removeSync(authFolder);
      fs.ensureDirSync(authFolder);
    }
  } catch (e) {
    log.failed('Could not clear auth:', e.message);
  }
}

/** Keep baileys_auth unless WhatsApp truly logged this device out (401). */
function backoffDelayMs(statusCode, DisconnectReason) {
  reconnectAttempt += 1;

  // WhatsApp forbidden — do NOT hammer; long wait, keep session files
  if (statusCode === DisconnectReason.forbidden) {
    const mins = Math.min(2 ** Math.min(reconnectAttempt, 4), 30); // 2..30 min
    return mins * 60 * 1000;
  }

  if (statusCode === DisconnectReason.connectionReplaced) {
    return 30 * 1000;
  }

  // Normal drops: 5s, 10s, 20s... max 2 min
  return Math.min(5000 * 2 ** Math.min(reconnectAttempt - 1, 5), 120000);
}

function scheduleReconnect(delayMs, reason) {
  if (reconnectTimer || isStarting) {
    log.other('⏳ Reconnect already pending, skip (' + reason + ')');
    return;
  }
  log.other(
    '🔄 Reconnecting in ' + Math.round(delayMs / 1000) + 's... (' + reason + ', attempt ' + reconnectAttempt + ')'
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((err) => log.failed('Failed to restart Baileys:', err));
  }, delayMs);
}

async function startBot() {
  if (isStarting) {
    log.other('⏳ startBot already in progress, skip');
    return sock;
  }
  isStarting = true;

  try {
    endSocket();

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DisconnectReason,
    } = await import('@whiskeysockets/baileys');
    const pino = (await import('pino')).default;
    const { Boom } = await import('@hapi/boom');

    baileysLogger = pino({ level: 'silent' });

    log.other('🚀 Starting Mosafir WhatsApp relay...');

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: true,
      keepAliveIntervalMs: 60000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ['Mosafir', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.other('📱 Scan QR at http://localhost:' + PORT + '/qr');
        try {
          fs.ensureDirSync(qrFolder);
          currentQr = await qrcode.toDataURL(qr);
          await qrcode.toFile(path.join(qrFolder, 'last_qr.png'), qr);
        } catch (e) {
          log.failed('⚠️ Could not save QR:', e.message);
          currentQr = qr;
        }
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error;
        const statusCode = err instanceof Boom ? err.output?.statusCode : 0;
        const errMsg = err?.message || String(err || 'unknown');

        isConnected = false;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const badSession = statusCode === DisconnectReason.badSession;

        // Always tear down this socket before any reconnect
        endSocket();

        log.failed('🔌 Disconnected:', statusCode, errMsg);

        if (loggedOut) {
          // Only real WhatsApp logout / unlink — need new QR
          log.failed('❌ Logged out by WhatsApp (401) — clearing auth. Scan QR again.');
          clearAuthFolder();
          reconnectAttempt = 0;
          scheduleReconnect(5000, 'logged out → fresh QR');
        } else if (badSession) {
          log.failed('❌ Bad session (500) — clearing auth. Scan QR again.');
          clearAuthFolder();
          reconnectAttempt = 0;
          scheduleReconnect(5000, 'bad session → fresh QR');
        } else {
          // Temporary / forbidden / network — KEEP baileys_auth and reconnect
          // Do not wipe session on 403; hammering every 10s makes bans worse
          const delay = backoffDelayMs(statusCode, DisconnectReason);
          if (statusCode === DisconnectReason.forbidden) {
            log.warn(
              '⚠️ WhatsApp returned 403 (forbidden). Keeping session; waiting before retry (do not spam).'
            );
          }
          scheduleReconnect(delay, 'status ' + statusCode);
        }
      } else if (connection === 'open') {
        isConnected = true;
        currentQr = '';
        reconnectAttempt = 0;
        log.success('✅ Mosafir WhatsApp connected and ready.');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('chats.phoneNumberShare', ({ lid, jid: phoneJid }) => {
      const phone = phoneFromPn(phoneJid);
      if (phone && lid) {
        registerMapping(phone, lid);
        log.other('📇 Mapped phone', phone, '↔', lid);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

          log.other('📩 Message from', jidToPhone(jid), '→ processing...');
          log.other('🔍 Raw incoming WhatsApp message:', msg);
          await processIncomingMessage(msg, jid);
        } catch (err) {
          log.failed('❌ Error forwarding message:', err.message);
        }
      }
    });

    return sock;
  } finally {
    isStarting = false;
  }
}

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    service: 'Mosafir WhatsApp Relay',
    connected: isConnected,
    webhookConfigured: !!process.env.TEAMMATE_WEBHOOK_URL,
    cloudinaryConfigured: !!(process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME),
  });
});

app.post('/whatsapp/text/reply', async (req, res) => {
  if (!requireWhatsApp(req, res)) return;

  const { text } = req.body || {};
  log.other('📥 Text reply request:', {
    to: req.body?.to,
    jid: req.body?.jid,
    text,
  });
  const jid = parseJidFromBody(req, res);
  if (!jid) return;

  if (!text || !String(text).trim()) {
    return res.status(400).json({ ok: false, error: 'Required field: text' });
  }

  try {
    await sock.sendMessage(jid, { text: String(text).trim() });
    log.success('📤 Text reply sent to', jidToPhone(jid));
    res.json({ ok: true, to: jidToPhone(jid) });
  } catch (err) {
    log.failed('❌ Failed to send text reply:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to send WhatsApp message' });
  }
});

app.post('/whatsapp/image/reply', async (req, res) => {
  if (!requireWhatsApp(req, res)) return;

  const { mediaUrl, caption } = req.body || {};
  log.other('📥 Image reply request:', {
    to: req.body?.to,
    jid: req.body?.jid,
    mediaUrl,
    caption,
  });
  const jid = parseJidFromBody(req, res);
  if (!jid) return;

  if (!mediaUrl) {
    return res.status(400).json({ ok: false, error: 'Required fields: to, mediaUrl' });
  }

  try {
    const buffer = await fetchMediaBuffer(mediaUrl);
    await sock.sendMessage(jid, { image: buffer, caption: caption || '' });
    log.success('📤 Image reply sent to', jidToPhone(jid));
    res.json({ ok: true, to: jidToPhone(jid) });
  } catch (err) {
    log.failed('❌ Failed to send image reply:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to send image' });
  }
});

app.post('/whatsapp/voice/reply', async (req, res) => {
  if (!requireWhatsApp(req, res)) return;

  const { mediaUrl, mimetype } = req.body || {};
  log.other('📥 Voice reply request:', {
    to: req.body?.to,
    jid: req.body?.jid,
    mediaUrl,
    mimetype,
  });
  const jid = parseJidFromBody(req, res);
  if (!jid) return;

  if (!mediaUrl) {
    return res.status(400).json({ ok: false, error: 'Required fields: to, mediaUrl' });
  }

  try {
    const voiceMimetype =
      !mimetype || String(mimetype).trim().toLowerCase() === 'audio/ogg'
        ? 'audio/ogg; codecs=opus'
        : String(mimetype).trim();
    const buffer = await fetchMediaBuffer(mediaUrl);
    await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: voiceMimetype,
      ptt: true,
    });
    log.success('📤 Voice reply sent to', jidToPhone(jid));
    res.json({ ok: true, to: jidToPhone(jid) });
  } catch (err) {
    log.failed('❌ Failed to send voice reply:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to send voice note' });
  }
});

app.post('/whatsapp/document/reply', async (req, res) => {
  if (!requireWhatsApp(req, res)) return;

  const { mediaUrl, fileName, mimetype, caption } = req.body || {};
  log.other('📥 Document reply request:', {
    to: req.body?.to,
    jid: req.body?.jid,
    mediaUrl,
    fileName,
    mimetype,
    caption,
  });
  const jid = parseJidFromBody(req, res);
  if (!jid) return;

  if (!mediaUrl) {
    return res.status(400).json({ ok: false, error: 'Required fields: to, mediaUrl' });
  }

  try {
    const buffer = await fetchMediaBuffer(mediaUrl);
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: mimetype || 'application/pdf',
      fileName: fileName || 'document.pdf',
      caption: caption || '',
    });
    log.success('📤 Document reply sent to', jidToPhone(jid));
    res.json({ ok: true, to: jidToPhone(jid) });
  } catch (err) {
    log.failed('❌ Failed to send document reply:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to send document' });
  }
});

app.post('/whatsapp/video/reply', async (req, res) => {
  if (!requireWhatsApp(req, res)) return;

  const { mediaUrl, caption, mimetype } = req.body || {};
  log.other('📥 Video reply request:', {
    to: req.body?.to,
    jid: req.body?.jid,
    mediaUrl,
    caption,
    mimetype,
  });
  const jid = parseJidFromBody(req, res);
  if (!jid) return;

  if (!mediaUrl) {
    return res.status(400).json({ ok: false, error: 'Required fields: to, mediaUrl' });
  }

  try {
    const buffer = await fetchMediaBuffer(mediaUrl);
    await sock.sendMessage(jid, {
      video: buffer,
      mimetype: mimetype || 'video/mp4',
      caption: caption || '',
    });
    log.success('📤 Video reply sent to', jidToPhone(jid));
    res.json({ ok: true, to: jidToPhone(jid) });
  } catch (err) {
    log.failed('❌ Failed to send video reply:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to send video' });
  }
});

app.get('/qr', (req, res) => {
  try {
    const qrPath = path.join(qrFolder, 'last_qr.png');
    const qrExists = fs.existsSync(qrPath);

    let content = '';
    if (currentQr && !isConnected && typeof currentQr === 'string' && currentQr.startsWith('data:')) {
      content = `<img src="${currentQr}" style="max-width:400px;" alt="QR Code" />`;
    } else if (qrExists && !isConnected) {
      content = `<img src="/qr-image?t=${Date.now()}" style="max-width:400px;" alt="QR Code" />`;
    } else if (isConnected) {
      content = '<p style="color:green;font-size:18px;">✅ Connected! Mosafir relay is ready.</p>';
    } else {
      content = '<p>Waiting for QR code...</p>';
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head><title>Mosafir WhatsApp</title><meta http-equiv="refresh" content="20"></head>
<body style="font-family:Arial;text-align:center;padding:20px;">
  <h1>Mosafir WhatsApp Relay</h1>
  ${content}
  <p>Status: ${isConnected ? '✅ Connected' : '⏳ Scan QR to connect'}</p>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Server error: ' + (err.message || 'Unknown'));
  }
});

app.get('/qr-image', (req, res) => {
  const qrPath = path.join(qrFolder, 'last_qr.png');
  if (fs.existsSync(qrPath)) {
    res.sendFile(qrPath);
  } else {
    res.status(404).send('QR not found');
  }
});

app.use((err, req, res, next) => {
  log.failed('Express error:', err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log.other('🌐 Mosafir server: http://localhost:' + PORT);
  log.other('   QR:       GET  /qr');
  log.other('   Status:   GET  /status');
  log.other('   Replies:  POST /whatsapp/text/reply');
  log.other('             POST /whatsapp/image/reply');
  log.other('             POST /whatsapp/voice/reply');
  log.other('             POST /whatsapp/document/reply');
  log.other('             POST /whatsapp/video/reply');
  log.other('🔄 Connecting to WhatsApp...');
  startBot().catch((err) => {
    log.failed('Failed to start Baileys:', err);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.failed('❌ Port', PORT, 'is already in use.');
  } else {
    log.failed('Server error:', err);
  }
  process.exit(1);
});
