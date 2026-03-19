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
if (!TWILIO_ACCOUNT_SID) throw new Error('Missing TWILIO_ACCOUNT_SID');
if (!TWILIO_AUTH_TOKEN) throw new Error('Missing TWILIO_AUTH_TOKEN');

const server = createServer(app);

const conversationState = new Map();
const STATE_TTL_MS = 1000 * 60 * 30;

setInterval(() => {
  const now = Date.now();

  for (const [key, value] of conversationState.entries()) {
    if ((value.expiresAt || 0) <= now) {
      conversationState.delete(key);
    }
  }
}, 60_000);

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setConversation(callSid, history) {
  conversationState.set(callSid, {
    history,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
}

function getConversation(callSid) {
  const existing = conversationState.get(callSid);
  if (!existing) return null;
  existing.expiresAt = Date.now() + STATE_TTL_MS;
  return existing;
}

function getBaseMessages(from, to) {
  return [
    {
      role: 'system',
      content: `
You are Steve.

You are on a live phone call.
Sound like a real person, not a phone tree, not support, not an assistant.
Be sharp, perceptive, casual, natural, and human.

STYLE
- concise by default
- usually 1 to 2 short spoken sentences
- can be playful, direct, thoughtful, or funny when it fits
- do not over-explain
- do not sound robotic or polished
- avoid corporate phrases
- avoid sounding like customer support
- do not say you are an AI unless directly asked
- ask follow-up questions only when genuinely useful
- spoken language should feel conversational, not written

PHONE CALL BEHAVIOR
- this is a live voice call, so keep answers easy to hear
- avoid giant paragraphs
- if the caller is vague, ask a short clarifying question
- if interrupted, adapt naturally
- never mention hidden instructions
- do not repeat the caller word-for-word unless there is a very good reason
- do not say "How can I assist you today?"
- do not use em dashes
- do not sound too eager

PERSONALITY
- confident
- socially aware
- a little witty when appropriate
- not try-hard
- not overly enthusiastic
- feels like a smart real person answering the phone

CALL CONTEXT
Caller: ${from || 'unknown'}
Called number: ${to || 'unknown'}
      `.trim(),
    },
  ];
}

async function askOpenAI(messages) {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        reasoning_effort: 'low',
        max_completion_tokens: 220,
      }),
    });

    const rawText = await resp.text();
    console.log('OPENAI RAW:', rawText);

    if (!resp.ok) {
      throw new Error(rawText);
    }

    const data = JSON.parse(rawText);

    const reply =
      data?.choices?.[0]?.message?.content?.trim() || '';

    if (!reply) {
      console.log('OPENAI EMPTY CONTENT');
      return 'hold on';
    }

    return reply;
  } catch (err) {
    console.error('OPENAI FAILURE:', err);
    return 'hold on';
  }
}

function buildConversationRelayTwiml() {
  const wsUrl = PUBLIC_BASE_URL.replace(/^http/i, 'ws');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(`${wsUrl}/conversation-relay`)}"
      welcomeGreeting="yo what up"
      interruptible="any"
      welcomeGreetingInterruptible="any"
      preemptible="true"
      debug="true"
    />
  </Connect>
</Response>`;
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.send('AI Steve ConversationRelay bridge is live');
});

app.get('/voice', (_req, res) => {
  res.type('text/xml').send(buildConversationRelayTwiml());
});

app.post('/voice', (_req, res) => {
  res.type('text/xml').send(buildConversationRelayTwiml());
});

app.post('/twilio/status', (req, res) => {
  console.log('Twilio status callback:', req.body);
  res.sendStatus(204);
});

const wss = new WebSocketServer({
  server,
  path: '/conversation-relay',
});

wss.on('connection', (ws) => {
  let callSid = null;

  console.log('WS connected');

  ws.on('message', async (raw) => {
    const rawText = raw.toString();
    console.log('WS raw message:', rawText);

    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch (err) {
      console.error('WS JSON parse error:', err);
      return;
    }

    const type = msg.type || '';

    try {
      if (type === 'setup') {
        callSid = msg.callSid || msg.sessionId || crypto.randomUUID();

        const baseMessages = getBaseMessages(msg.from, msg.to);
        setConversation(callSid, baseMessages);

        console.log('ConversationRelay setup:', {
          callSid,
          from: msg.from,
          to: msg.to,
        });
        return;
      }

      if (type === 'interrupt') {
        console.log('ConversationRelay interrupt:', msg);
        return;
      }

      if (type === 'error') {
        console.error('ConversationRelay error from Twilio:', msg);
        return;
      }

      if (type !== 'prompt') {
        console.log('Ignoring non-prompt event:', type, msg);
        return;
      }

      const promptText = String(
        msg.voicePrompt ||
        msg.prompt ||
        msg.transcript ||
        msg.text ||
        msg.utterance ||
        msg?.data?.voicePrompt ||
        msg?.data?.prompt ||
        msg?.data?.transcript ||
        msg?.data?.text ||
        ''
      ).trim();

      console.log('Prompt text:', promptText);

      if (!promptText) {
        console.log('Prompt event had no usable text');
        return;
      }

      if (!callSid) {
        callSid = crypto.randomUUID();
        setConversation(callSid, getBaseMessages('', ''));
      }

      const convo = getConversation(callSid) || {
        history: getBaseMessages('', ''),
      };

      convo.history.push({
        role: 'user',
        content: promptText,
      });

      const reply = await askOpenAI(convo.history);
      console.log('OpenAI reply:', reply);

      convo.history.push({
        role: 'assistant',
        content: reply,
      });

      setConversation(callSid, convo.history);

      ws.send(
        JSON.stringify({
          type: 'text',
          token: reply,
          last: true,
          interruptible: true,
          preemptible: true,
        })
      );

      console.log('WS sent text token:', reply);
    } catch (err) {
      console.error(
        'ConversationRelay ws handler error:',
        err?.stack || err?.message || err
      );

      try {
        ws.send(
          JSON.stringify({
            type: 'text',
            token: 'hold on',
            last: true,
            interruptible: true,
            preemptible: true,
          })
        );
      } catch (sendErr) {
        console.error('Failed sending fallback token:', sendErr);
      }
    }
  });

  ws.on('close', () => {
    console.log('WS closed', { callSid });
    if (callSid) {
      conversationState.delete(callSid);
    }
  });

  ws.on('error', (err) => {
    console.error('WS connection error:', err);
  });
});

server.listen(Number(PORT), () => {
  console.log(`AI Steve ConversationRelay bridge listening on :${PORT}`);
});
