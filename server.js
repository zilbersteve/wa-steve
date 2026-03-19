import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  PORT = '3000',
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_VOICE_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (!PUBLIC_BASE_URL) throw new Error('Missing PUBLIC_BASE_URL');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!ELEVENLABS_API_KEY) throw new Error('Missing ELEVENLABS_API_KEY');
if (!ELEVENLABS_AGENT_ID) throw new Error('Missing ELEVENLABS_AGENT_ID');
if (!ELEVENLABS_VOICE_ID) throw new Error('Missing ELEVENLABS_VOICE_ID');
if (!TWILIO_ACCOUNT_SID) throw new Error('Missing TWILIO_ACCOUNT_SID');
if (!TWILIO_AUTH_TOKEN) throw new Error('Missing TWILIO_AUTH_TOKEN');
if (!TWILIO_MESSAGING_SERVICE_SID && !TWILIO_PHONE_NUMBER) {
  throw new Error('Missing TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER');
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const audioCache = new Map();
const AUDIO_TTL_MS = 1000 * 60 * 20;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of audioCache.entries()) {
    if (value.expiresAt <= now) {
      audioCache.delete(key);
    }
  }
}, 60_000);

function isWhatsAppAddress(value) {
  return String(value || '').startsWith('whatsapp:');
}

function ensureWhatsAppAddress(value) {
  const v = String(value || '').trim();
  if (!v) return v;
  return v.startsWith('whatsapp:') ? v : `whatsapp:${v}`;
}

function cleanCaption(text, maxLen = 250) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function storeAudio(buffer, mimeType = 'audio/mpeg') {
  const id = crypto.randomUUID();
  audioCache.set(id, {
    buffer,
    mimeType,
    expiresAt: Date.now() + AUDIO_TTL_MS,
  });
  return `${PUBLIC_BASE_URL}/media/${id}.mp3`;
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.send('AI Steve WhatsApp + Voice bridge is live');
});

app.get('/media/:id.mp3', (req, res) => {
  const entry = audioCache.get(req.params.id);
  if (!entry || entry.expiresAt <= Date.now()) {
    return res.status(404).send('Not found');
  }

  res.setHeader('Content-Type', entry.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(entry.buffer);
});

async function getSignedUrl(agentId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    {
      method: 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get signed URL: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (!data.signed_url) {
    throw new Error('No signed_url returned');
  }

  return data.signed_url;
}

function waitForAgentReply(ws, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for agent response'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      reject(new Error('WebSocket closed before agent replied'));
    }

    function onMessage(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        const type = msg.type || msg.event || '';

        if (
          type === 'agent_response' ||
          type === 'agent_response_correction' ||
          type === 'conversation.agent_response' ||
          type === 'response'
        ) {
          const text =
            msg.agent_response_event?.agent_response ||
            msg.agent_response ||
            msg.text ||
            msg.message;

          if (text && String(text).trim()) {
            cleanup();
            resolve(String(text).trim());
          }
        }

        const nestedText =
          msg?.data?.agent_response ||
          msg?.data?.text ||
          msg?.payload?.text;

        if (nestedText && String(nestedText).trim()) {
          cleanup();
          resolve(String(nestedText).trim());
        }
      } catch {
        // ignore irrelevant frames
      }
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

async function askElevenLabsAgentText(userText, fromNumber) {
  const signedUrl = await getSignedUrl(ELEVENLABS_AGENT_ID);

  const prompt = `
You are Steve.
Reply naturally and casually like a real human.
Keep most replies 1-3 sentences.
Do not sound robotic or corporate.
Be sharp, warm, casual, and human.
Latest inbound message from ${fromNumber}:
${userText}
`.trim();

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(signedUrl);

    ws.on('open', async () => {
      try {
        ws.send(
          JSON.stringify({
            type: 'conversation_initiation_client_data',
            conversation_config_override: {
              conversation: {
                text_only: true,
              },
            },
          })
        );

        ws.send(
          JSON.stringify({
            type: 'user_message',
            text: prompt,
          })
        );

        ws.send(JSON.stringify({ type: 'user_message_end' }));

        const reply = await waitForAgentReply(ws);
        ws.close();
        resolve(reply);
      } catch (err) {
        try {
          ws.close();
        } catch {}
        reject(err);
      }
    });

    ws.on('error', reject);
  });
}

async function generateVoiceMp3(text) {
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.9,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!resp.ok) {
    const textErr = await resp.text();
    throw new Error(`TTS failed: ${resp.status} ${textErr}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function sendWhatsAppVoice(to, text) {
  const mp3 = await generateVoiceMp3(text);
  const mediaUrl = storeAudio(mp3);

  const payload = {
    to: ensureWhatsAppAddress(to),
    body: cleanCaption(text),
    mediaUrl: [mediaUrl],
    statusCallback: `${PUBLIC_BASE_URL}/twilio/status`,
  };

  if (TWILIO_MESSAGING_SERVICE_SID) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = ensureWhatsAppAddress(TWILIO_PHONE_NUMBER);
  }

  return await twilioClient.messages.create(payload);
}

async function sendWhatsAppText(to, text) {
  const payload = {
    to: ensureWhatsAppAddress(to),
    body: text,
    statusCallback: `${PUBLIC_BASE_URL}/twilio/status`,
  };

  if (TWILIO_MESSAGING_SERVICE_SID) {
    payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = ensureWhatsAppAddress(TWILIO_PHONE_NUMBER);
  }

  return await twilioClient.messages.create(payload);
}

async function buildVoiceTwiml(text) {
  try {
    const mp3 = await generateVoiceMp3(text);
    const mediaUrl = storeAudio(mp3);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(mediaUrl)}</Play>
</Response>`;
  } catch (err) {
    console.error('Voice TTS error, falling back to Twilio Say:', err);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(text)}</Say>
</Response>`;
  }
}

async function handleVoice(req, res) {
  try {
    const from = String(req.body?.From || req.query?.From || '').trim();

    const greeting = from
      ? 'yo what up, you got steve. leave me a thought.'
      : 'yo what up, you got steve.';

    const twiml = await buildVoiceTwiml(greeting);
    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('Voice webhook error:', err);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">yo, something glitched on my side.</Say>
</Response>`);
  }
}

app.get('/voice', handleVoice);
app.post('/voice', handleVoice);

app.post('/whatsapp', async (req, res) => {
  const from = String(req.body.From || '').trim();
  const body = String(req.body.Body || '').trim();

  res.type('text/xml').send('<Response></Response>');

  if (!from) return;

  try {
    if (!body) {
      await sendWhatsAppText(
        from,
        'yo — send me text for now and i’ll answer with voice.'
      );
      return;
    }

    const replyText = await askElevenLabsAgentText(body, from);
    if (!replyText) return;

    await sendWhatsAppVoice(from, replyText);
  } catch (err) {
    console.error('WhatsApp voice error:', err);
    await sendWhatsAppText(
      from,
      'yo… something glitched on my side. send that again in a sec.'
    ).catch((sendErr) => {
      console.error('fallback send failed:', sendErr);
    });
  }
});

app.post('/twilio/status', (req, res) => {
  console.log('Twilio status callback:', req.body);
  res.sendStatus(204);
});

app.listen(Number(PORT), () => {
  console.log(`AI Steve WhatsApp + Voice bridge listening on :${PORT}`);
});
