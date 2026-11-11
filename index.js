import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || './session';
const ROOTLY_API_KEY = process.env.ROOTLY_API_KEY || 'sk-ry-pLQG0K3D5HqkcA4Gw4gJzZalTu0kBze7PAyCQqFD8AU';
const ROOTLY_BASE_URL = process.env.ROOTLY_BASE_URL || 'https://secure.rootly.my.id/v1';

// Prioritas model AI
const AI_MODELS = [
  'zai-org/GLM-5.3-Flash',
  'MiniMaxAI/MiniMax-M2.7',
  'deepseek-ai/DeepSeek-V4-Flash-0731'
];

let sock = null;
let qrCodeDataUrl = null;
let connectionStatus = 'Menghubungkan...';
let botPhoneNumber = '';

// Inisialisasi Express Web Dashboard
const app = express();
app.use(express.json());

// Endpoint Keep-Alive untuk UptimeRobot / Cron
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', connection: connectionStatus }));

// Halaman Web Utama untuk Scan QR & Cek Status
app.get('/', (req, res) => {
  const isConnected = connectionStatus === 'Terhubung';
  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp AI Bot - PojokAI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #1e293b; border-radius: 20px; padding: 32px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); border: 1px solid #334155; }
    .badge { display: inline-block; padding: 6px 14px; border-radius: 9999px; font-size: 13px; font-weight: 600; margin-bottom: 20px; }
    .badge-connected { background: #065f46; color: #34d399; }
    .badge-waiting { background: #854d0e; color: #facc15; }
    .badge-disconnected { background: #7f1d1d; color: #f87171; }
    h1 { font-size: 24px; margin-bottom: 8px; font-weight: 700; }
    p { color: #94a3b8; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
    .qr-container { background: #ffffff; padding: 16px; border-radius: 16px; display: inline-block; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .qr-container img { width: 240px; height: 240px; display: block; }
    .instructions { background: #0f172a; border-radius: 12px; padding: 16px; text-align: left; font-size: 13px; color: #cbd5e1; }
    .instructions ol { padding-left: 20px; }
    .instructions li { margin-bottom: 6px; }
    .success-box { background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .success-icon { font-size: 48px; margin-bottom: 8px; }
  </style>
  ${!isConnected ? '<meta http-equiv="refresh" content="5">' : ''}
</head>
<body>
  <div class="card">
    <div class="badge ${isConnected ? 'badge-connected' : (qrCodeDataUrl ? 'badge-waiting' : 'badge-disconnected')}">
      ● ${connectionStatus}
    </div>
    <h1>WhatsApp AI Bot</h1>
    <p>Asisten AI Cerdas untuk Chat Pribadi & Grup WhatsApp (24/7 di Render).</p>

    ${isConnected ? `
      <div class="success-box">
        <div class="success-icon">✅</div>
        <h3 style="color: #34d399; margin-bottom: 6px;">WhatsApp Telah Aktif!</h3>
        <p style="color: #cbd5e1; margin-bottom: 0;">Nomor: <b>${botPhoneNumber || 'Bot Aktif'}</b></p>
      </div>
      <div class="instructions">
        <b>Cara Menggunakan:</b>
        <ol style="margin-top: 8px;">
          <li><b>Di Chat Pribadi:</b> Langsung kirim pesan ke bot, bot akan langsung membalas.</li>
          <li><b>Di Grup WA:</b> Masukkan nomor bot ini ke grup, lalu <b>@mention / tag</b> nomor bot untuk bertanya.</li>
        </ol>
      </div>
    ` : (qrCodeDataUrl ? `
      <div class="qr-container">
        <img src="${qrCodeDataUrl}" alt="Scan QR Code" />
      </div>
      <div class="instructions">
        <b>Langkah Tautkan WhatsApp:</b>
        <ol style="margin-top: 8px;">
          <li>Buka WhatsApp di HP Anda.</li>
          <li>Ketuk <b>Titik Tiga / Pengaturan</b> → <b>Perangkat Tertaut</b>.</li>
          <li>Ketuk <b>Tautkan Perangkat</b> lalu scan QR di atas.</li>
          <li><i>Halaman ini akan auto-refresh setiap 5 detik.</i></li>
        </ol>
      </div>
    ` : `
      <p style="padding: 40px 0;">Menyiapkan sesi WhatsApp... Silakan refresh beberapa saat lagi.</p>
    `)}
  </div>
</body>
</html>
  `;
  res.send(html);
});

// Fungsi Panggilan Model AI Rootly dengan Auto-Fallback
async function callRootlyAI(prompt, conversationHistory = []) {
  const messages = [
    {
      role: 'system',
      content: 'Kamu adalah asisten AI cerdas, ramah, dan solutif di WhatsApp. Jawablah pertanyaan pengguna dengan jelas, akurat, dan format pesan WhatsApp yang rapi (*tebal*, _miring_, list bullet).'
    },
    ...conversationHistory,
    { role: 'user', content: prompt }
  ];

  for (const model of AI_MODELS) {
    try {
      console.log(`[AI] Mencoba model: ${model}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout

      const response = await fetch(`${ROOTLY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ROOTLY_API_KEY}`
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: 0.7,
          max_tokens: 1500
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content;
        if (reply && reply.trim()) {
          return reply.trim();
        }
      } else {
        console.warn(`[AI] Model ${model} mengembalikan status ${response.status}`);
      }
    } catch (err) {
      console.warn(`[AI] Gagal dengan model ${model}:`, err.message);
    }
  }

  return "Maaf, saat ini layanan AI sedang mengalami kepadatan traffic. Silakan coba kirim pesan beberapa saat lagi ya!";
}

// Inisialisasi Koneksi Baileys
async function startWhatsApp() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['PojokAI Bot', 'Chrome', '120.0'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'Menunggu Scan QR Code';
      try {
        qrCodeDataUrl = await qrcode.toDataURL(qr);
      } catch (err) {
        console.error('Gagal generate QR Data URL:', err);
      }
      console.log('\n[WhatsApp] QR Code baru siap di-scan via web dashboard!\n');
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = shouldReconnect ? 'Terputus (Menghubungkan ulang...)' : 'Sesi Berakhir (Perlu scan ulang)';
      qrCodeDataUrl = null;
      console.log(`[WhatsApp] Koneksi ditutup (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'Terhubung';
      qrCodeDataUrl = null;
      botPhoneNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Aktif';
      console.log(`\n[WhatsApp] ✅ Berhasil Terhubung! Nomor Bot: ${botPhoneNumber}\n`);
    }
  });

  // Handler Pesan Masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // Abaikan pesan dari bot sendiri atau status
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;

        const chatId = msg.key.remoteJid;
        const isGroup = chatId.endsWith('@g.us');

        // Ekstrak teks pesan
        const messageText = 
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          '';

        if (!messageText.trim()) continue;

        // Logika Respon:
        // 1. Jika Chat Pribadi (DM): Selalu balas
        // 2. Jika Grup: Hanya balas jika di-mention ATAU mereply chat bot
        const botId = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : '';
        const botLid = sock.user?.lid ? sock.user.lid.split(':')[0] + '@lid' : '';
        const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isMentioned = mentionedJids.includes(botId) || (botLid && mentionedJids.includes(botLid));

        const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
        const isReplyToBot = quotedParticipant === botId || (botLid && quotedParticipant === botLid);

        if (isGroup && !isMentioned && !isReplyToBot) {
          // Abaikan obrolan santai antar member grup
          continue;
        }

        console.log(`[Pesan Masuk] Dari: ${chatId} (${isGroup ? 'Grup' : 'DM'}) | Isi: ${messageText.slice(0, 50)}...`);

        // Kirim indikator sedang mengetik
        await sock.sendPresenceUpdate('composing', chatId);

        // Bersihkan teks dari mention @bot
        let cleanText = messageText.replace(/@\d+/g, '').trim();
        if (!cleanText) cleanText = 'Halo!';

        // Panggil AI
        const aiReply = await callRootlyAI(cleanText);

        // Balas pesan (quote pesan pengirim)
        await sock.sendMessage(chatId, { text: aiReply }, { quoted: msg });
        await sock.sendPresenceUpdate('paused', chatId);

      } catch (err) {
        console.error('[Error Pesan]:', err.message);
      }
    }
  });
}

// Jalankan Web Server & WhatsApp Socket
app.listen(PORT, () => {
  console.log(`[Server] Web Dashboard aktif di port ${PORT}`);
  startWhatsApp();
});
