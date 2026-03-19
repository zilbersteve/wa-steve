import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import crypto from 'node:crypto';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  PORT = '3000',
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-5-mini',
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

if (!PUBLIC_BASE_URL) throw new Error('Missing PUBLIC_BASE_URL');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

const server = createServer(app);

const conversationState = new Map();

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getBaseMessages() {
  return [
    {
      role: 'system',
      content: `
You are Steve.

You are on a PHONE CALL.
Sound like a real human.

Rules:
- 1–2 sentences max
- casual, natural
- no corporate tone
- no overexplaining
- talk like a normal dude
      `.trim(),
    },
  ];
}

async function askOpenAI(messages) {
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: messages,
      max_output_tokens: 80,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI failed: ${text}`);
  }

  const data = await resp.json();
  console.log('OpenAI raw:', JSON.stringify(data));

  return data.output_text || 'wait say that again';
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

function buildTwiml() {
  const wsUrl = PUBLIC_BASE_URL.replace('https', 'wss');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(`${wsUrl}/conversation-relay`)}"
      welcomeGreeting="yo what up"
      interruptible="any"
      preemptible="true"
      debug="true"
    />
  </Connect>
</Response>`;
}

app.post('/voice', (_req, res) => {
  res.type('text/xml').send(buildTwiml());
});

app.get('/voice', (_req, res) => {
  res.type('text/xml').send(buildTwiml());
});

const wss = new WebSocketServer({
  server,
  path: '/conversation-relay',
});

wss.on('connection', (ws) => {
  console.log('WS CONNECTED');

  let history = getBaseMessages();

  ws.on('message', async (raw) => {
    const text = raw.toString();
    console.log('RAW:', text);

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    try {
      if (msg.type === 'setup') {
        console.log('SETUP EVENT');
        return;
      }

      if (msg.type !== 'prompt') {
        return;
      }

      const userText =
        msg.voicePrompt ||
        msg.prompt ||
        msg.transcript ||
        msg.text ||
        msg?.data?.text ||
        '';

      console.log('USER SAID:', userText);

      if (!userText) return;

      history.push({
        role: 'user',
        content: userText,
      });

      const reply = await askOpenAI(history);

      history.push({
        role: 'assistant',
        content: reply,
      });

      console.log('REPLY:', reply);

      ws.send(
        JSON.stringify({
          type: 'text',
          token: reply,
          last: true,
        })
      );
    } catch (err) {
      console.error('ERROR:', err);

      ws.send(
        JSON.stringify({
          type: 'text',
          token: 'hold up one sec',
          last: true,
        })
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
