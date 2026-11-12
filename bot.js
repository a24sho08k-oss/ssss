
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys';

import { GoogleGenAI } from '@google/genai';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';

const PORT = process.env.PORT || 10000;
const AUTH_DIR = process.env.AUTH_DIR || './session';
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is missing');
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const app = express();

app.get('/', (req, res) => {
  res.send('WhatsApp AI Bot is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web server running on ${PORT}`);
});

fs.mkdirSync(AUTH_DIR, { recursive: true });

const histories = new Map();
const busy = new Set();

const INSTRUCTIONS = `
You are a helpful ChatGPT-style WhatsApp AI assistant.

Reply in the same language as the user.
Understand Tamil written in English letters (Tanglish).
Explain difficult subjects in simple Tamil.
Be friendly, accurate and clear.
Use headings and bullet points when useful.
For medical questions, provide educational information,
not a medical diagnosis.
Keep answers suitable for WhatsApp.
`;

function extractText(message) {
  let m = message;

  while (m?.ephemeralMessage?.message) {
    m = m.ephemeralMessage.message;
  }

  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    ''
  ).trim();
}

function getHistory(jid) {
  if (!histories.has(jid)) {
    histories.set(jid, []);
  }

  return histories.get(jid);
}

async function askGemini(jid, question) {
  const history = getHistory(jid);

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [{ text: question }]
    }
  ];

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: INSTRUCTIONS,
      maxOutputTokens: 1000
    }
  });

  const answer = response.text?.trim();

  if (!answer) {
    throw new Error('Empty AI response');
  }

  history.push(
    { role: 'user', parts: [{ text: question }] },
    { role: 'model', parts: [{ text: answer }] }
  );

  // Keep only the last 6 exchanges
  while (history.length > 12) {
    history.splice(0, 2);
  }

  return answer;
}

async function sendAnswer(sock, jid, answer, msg) {
  const size = 3000;

  for (let i = 0; i < answer.length; i += size) {
    await sock.sendMessage(
      jid,
      { text: answer.slice(i, i + size) },
      { quoted: msg }
    );
  }
}

let reconnecting = false;

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['AI WhatsApp Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR using WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnecting = false;
      console.log('WhatsApp AI Bot Connected!');
    }

    if (connection === 'close' && !reconnecting) {
      const status =
        lastDisconnect?.error?.output?.statusCode;

      console.log('Connection closed:', status);

      if (status === DisconnectReason.loggedOut) {
        console.log('WhatsApp logged out. Re-link required.');
        return;
      }

      reconnecting = true;

      setTimeout(() => {
        startBot().catch(err => {
          console.error('Reconnect error:', err);
          reconnecting = false;
        });
      }, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;

      if (
        !jid ||
        jid === 'status@broadcast' ||
        jid.endsWith('@newsletter')
      ) continue;

      const isGroup = jid.endsWith('@g.us');
      let question = extractText(msg.message);

      if (!question) continue;

      // In groups, only respond to .ai
      if (isGroup) {
        if (!question.toLowerCase().startsWith('.ai ')) {
          continue;
        }

        question = question.slice(4).trim();
      }

      if (!question) continue;

      const lower = question.toLowerCase();

      if (lower === '.help' || lower === 'help') {
        await sock.sendMessage(jid, {
          text:
`🤖 WHATSAPP AI BOT

Private chat:
Send any question.

Group:
.ai your question

Commands:
.ping - Bot status
.reset - Clear conversation
.help - Help`
        }, { quoted: msg });

        continue;
      }

      if (lower === '.ping') {
        await sock.sendMessage(jid, {
          text: '🤖 AI Bot Online!'
        }, { quoted: msg });

        continue;
      }

      if (lower === '.reset') {
        histories.delete(jid);

        await sock.sendMessage(jid, {
          text: '🧹 Conversation cleared!'
        }, { quoted: msg });

        continue;
      }

      if (busy.has(jid)) {
        await sock.sendMessage(jid, {
          text: '⏳ முந்தைய பதில் தயாராகிறது. சிறிது நேரம் காத்திருக்கவும்.'
        });
        continue;
      }

      busy.add(jid);

      try {
        await sock.sendMessage(jid, {
          text: '🤖 AI யோசித்துக்கொண்டிருக்கிறது...'
        });

        const answer = await askGemini(jid, question);

        await sendAnswer(sock, jid, answer, msg);

      } catch (error) {
        console.error('Gemini error:', error);

        await sock.sendMessage(jid, {
          text: '❌ AI பதில் கிடைக்கவில்லை. API quota மற்றும் Logs சரிபார்க்கவும்.'
        });

      } finally {
        busy.delete(jid);
      }
    }
  });
}

startBot().catch(console.error);
