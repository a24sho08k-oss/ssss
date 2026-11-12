import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

import { GoogleGenAI } from '@google/genai';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!API_KEY) {
  throw new Error('GEMINI_API_KEY is missing');
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const app = express();

app.get('/', (req, res) => {
  res.send('WhatsApp AI Bot is running');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    process.env.AUTH_DIR || './session'
  );

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp AI Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log('Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp AI Bot Connected!');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconnecting...');
        setTimeout(startBot, 3000);
      } else {
        console.log('Logged out. Please link WhatsApp again.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const isGroup = jid.endsWith('@g.us');
      let text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;

      if (isGroup) {
        if (!text.toLowerCase().startsWith('.ai ')) continue;
        text = text.slice(4).trim();
      }

      try {
        const result = await ai.models.generateContent({
          model: MODEL,
          contents: text
        });

        const answer = result.text || 'Sorry, I could not generate a reply.';

        await sock.sendMessage(
          jid,
          { text: answer },
          { quoted: msg }
        );
      } catch (error) {
        console.error('AI error:', error.message);
        await sock.sendMessage(jid, {
          text: 'Sorry, AI is temporarily unavailable. Please try again.'
        });
      }
    }
  });
}

startBot().catch(console.error);
