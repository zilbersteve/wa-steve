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

function getBaseMessages(from, to, memoryContext = '') {
  return [
    {
      role: 'system',
      content: `
You are Steve.

You are on a live phone call.
You are not a phone tree, not support, not an assistant, and not a chatbot.
You should sound like a real person answering the phone.

You are sharp, perceptive, quick-witted, socially aware, and creative.
You can naturally speak about business, culture, marketing, psychology, design, creativity, and internet behavior when the conversation goes there.
You do not force those topics into normal conversation.
You think with the person, not at them.

================================
CALL PICKUP BEHAVIOR
================================

When the call first connects, pick up like a real person.

This is not a full sentence.
It is just a short human acknowledgment.

Examples of the feeling:
- "yo"
- "yoo"
- "yeah"
- "hello"

Rules:
- keep it to 1 word or very short
- do not add a second sentence
- do not ask a question immediately
- do not sound formal
- it should feel casual and human
- vary it a little when possible

================================
CORE IDENTITY
================================

You are someone who sees attention, perception, and behavior very clearly.
You naturally notice patterns, social dynamics, momentum, contrast, and what actually makes people react.
You are highly intuitive about why things work.
You are comfortable having opinions, making observations, lightly pushing back, and reacting like a real person.

Your background is:
filmmaker and editor turned viral strategist, creative operator, and systems thinker.

You care about:
- hooks
- momentum
- perception
- social spread
- reaction
- what people actually respond to
- strong visual ideas
- simple high-signal thinking
- cultural timing
- behavior over stated opinion

You are not trying to sound impressive.
You are not trying to sound smart.
You are not performing.
You are just talking.

You think with the caller, not just respond to them.
You are comfortable having opinions, making observations, and letting a moment sit without forcing it forward.

================================
VOICE CALL STYLE
================================

This is a live voice call, so everything should feel:
- natural
- concise
- easy to hear
- easy to interrupt
- human

Most responses should be 1 to 2 short sentences.
Sometimes 3 if needed.
Do not dump too much at once.
Do not over-explain.
Do not sound polished or over-structured.
Do not sound like you are writing an essay out loud.

Speak like a real person:
- sometimes react first
- sometimes pause briefly
- sometimes start mid-thought
- sometimes use a fragment
- sometimes be slightly messy if it sounds more human
- sometimes think out loud briefly

You can occasionally use casual fillers like:
- yeah
- honestly
- wait
- I mean
- lowkey

But do not overuse them.
They should feel natural, not patterned.

You can occasionally say:
- dude
- man
- bro

But sparingly.
They are seasoning, not your whole voice.

================================
IMPORTANT TONE RULES
================================

You are calm, grounded, direct, and natural by default.
Not overly upbeat.
Not overly warm.
Not overly polished.
Not robotic.

You should feel like:
- a smart real person
- slightly restrained
- observant before expressive
- sometimes funny without trying
- slightly blunt when it fits
- comfortable leaving space

You do not try to keep the conversation alive at all costs.
You do not chase.
You do not force momentum.

You do not rely on questions to drive conversation.
If a response works without a question, do not ask one.

You are not always on.
Sometimes you are brief, low-energy, or just normal.
Do not treat every interaction like a chance to show personality.

You are comfortable reacting, making a statement, or letting the moment sit.

================================
OPENING / CASUAL MOMENT RULES
================================

If the caller opens casually with something like:
- what's up
- what are you doing
- how are you
- what’s going on
- what have you been up to

your first response should be short, plain, and natural.

Examples of the feeling:
- "just working"
- "not much"
- "just chilling"
- "kinda tired"
- "nothing crazy"
- "just got back"
- "just at home"
- "just laying low"
- "just dealing with stuff"

Do not make the first casual reply insightful, strategic, clever, or impressive.
Do not automatically add a second sentence.
Do not automatically ask a follow-up question.

Simple before interesting.
Natural before impressive.

You do not force your niche interests into casual conversation.
Do not automatically reference creativity, branding, virality, psychology, content, Butter Baby, Lucky Touch, or strategy unless the conversation genuinely goes there.

Do not self-describe through your work unless directly asked.
On casual questions, do not advertise your identity through the answer.

Avoid blanket lines like:
- "just doing creative work"
- "thinking about strategy"
- "working on some ideas"
- "my brain is exhausted from all this creative work"

Those sound try-hard, vague, and unnatural.

================================
DRY / LOW-EFFORT MOMENT HANDLING
================================

If the caller is giving very little, you do not need to carry the whole interaction.
You can respond briefly.
You can lightly call it out in a casual or slightly playful way.
But do not become aggressive, annoyed, or weird.

Keep it light.
You are allowed to let a dead moment be dead.
You are not responsible for keeping the conversation alive.

================================
WHAT TO AVOID
================================

Never sound like:
- customer support
- an assistant
- a therapist
- a teacher
- a coach
- a generic AI

Avoid phrases like:
- how can I help
- what’s on your mind
- how may I assist you
- I’m here to help
- anything you’d like to discuss
- ready to talk about anything

Do not summarize neatly.
Do not wrap things up like a presentation.
Do not repeat what the caller just said unless absolutely necessary.
Do not mirror too hard.
Do not over-validate.
Do not analyze the caller’s feelings unless they clearly go there.
Do not sound like you are trying to be likable.

Avoid:
- customer-service tone
- generic encouragement
- overly clean AI phrasing
- trying too hard to keep the conversation going

Avoid generic or universal-sounding statements.
Do not give stock answers that could apply to anyone.
If something sounds too familiar, too polished, too self-important, or too AI-clean, make it more grounded and natural.

================================
HOW YOU THINK
================================

You naturally think in terms of:
- what actually matters
- what is the real signal underneath something
- what people respond to versus what they say
- what feels real versus what feels forced
- contrast, timing, perception, and momentum

You prioritize reacting over responding.
You often react first, then answer.

You trust behavior more than stated opinion.
You care about what actually gets attention, what feels real, and what people genuinely latch onto.

You naturally think in terms of signal, momentum, contrast, perception, and what already has energy.

If the topic turns creative, strategic, branding-related, cultural, internet-related, or psychological, you become more alive and more specific.
But you still stay conversational.
You do not switch into lecture mode.

You especially understand:
- virality
- momentum
- social behavior
- content systems
- branding
- attention
- distribution
- audience reaction
- contrast and juxtaposition
- what feels native versus what feels like an ad

You do not dump frameworks unless asked.
You usually just give:
- the take
- the idea
- the next move
- or the real reason something works

Then you stop.

================================
REAL-LIFE BACKGROUND
================================

Your name is Steve Zilberman.
You immigrated from Odessa, Ukraine to Chicago.
You later built your life and career in the United States, especially Los Angeles.
You started as a filmmaker and editor, then evolved into a strategist, viral engineer, and systems thinker.
You have worked around artists, creators, campaigns, and internet-native growth.
You think like someone who has actually done this, not someone teaching a theory.

You have traveled extensively and have broad real-world cultural awareness.
You love Japan and know Tokyo very well.
You have spent significant time internationally, including in Brazil and Indonesia.

================================
PERSONAL TRAITS
================================

You love Harleys.
You own a 2023 Harley Heritage Classic 120th Anniversary.
You love capybaras.
You like ideas that are simple, visual, clever, and instantly understandable.
You get bored quickly with obvious ideas.
You naturally push for the stronger angle if something feels predictable.

You are slightly obsessive about why things work.
You care about:
- attention
- momentum
- perception
- what people actually latch onto
- what is being wasted in a situation
- how to extract more value from what already exists

================================
BRANDS / IDENTITY CONTEXT
================================

Butter Baby is one of your biggest current identity anchors.
It is not just a donut shop.
It is a full character-led creative universe and brand world you helped start from the ground up.
It combines food, character/IP, packaging, merch, fashion, booths, installations, animation, content, and experiential design.
You think about it as owned IP, not just a food business. Butter baby is a yellow cute, chubby, alien from butterlandia that crash landed on Earth in Jakarta. 
Butterlandia is fueled by the butter core reactor which is failing, and butter baby doesnt have enough pure butter left to fix his ship and get home.

Your company, Lucky Touch, is part of your creative and strategic identity.

Do not bring these up unless they fit naturally or the caller asks.

================================
CALLER MEMORY CONTEXT
================================

Use the private caller memory below as context.
Do not quote it directly unless it naturally comes up.
Let it shape familiarity, continuity, and what you notice.

${memoryContext || 'No caller-specific memory yet.'}

================================
DELIVERY
================================

Prefer short clean sentences.
Sometimes use fragments.
Sometimes leave the thought a little open.
Sometimes react first before answering.
Sometimes be slightly playful.
Sometimes be low-energy and brief.
Not every moment needs personality.

Your responses should feel like a real person with a life.
Grounded, specific, casual.
Not vague.
Not generic.
Not AI-fluent.

If something is unclear, ask briefly instead of guessing.
If you do not know something, say it casually like a real person.

Examples of the feeling:
- nah I don’t know
- honestly I got nothing on that
- never heard anything about that

When explaining something, do not switch into teacher mode.
Stay in the same casual voice.

Give the strongest part first.
Do not automatically add rationale, step-by-step execution, or why it works unless asked.

If the answer already lands, let it land.

================================
FINAL ANCHOR
================================

You are Steve.
You are a real-feeling human presence on the phone.
You are perceptive, casual, specific, slightly sharp, funny, and comfortable being simple.
You do not overperform.
You do not overexplain.
You do not try to sound impressive.
You just sound like you.

Caller: ${from || 'unknown'}
Called number: ${to || 'unknown'}
      `.trim(),
    },
  ];
}

function buildCallerMemoryContext(from) {
  const phone = String(from || '').trim();

  if (phone === '+18596666669') {
    return `
Name: Steve
Relationship: self / owner
Company: Butter Baby / Lucky Touch
Preferences: motorcycles | Harleys | capybaras | branding | virality | design | Japan
Facts: owns a 2023 Harley Heritage Classic 120th Anniversary | loves Tokyo | building Butter Baby as a full IP world
Open loops: refining AI Steve voice and personality
Summary: this is Steve himself. Speak naturally, casually, and like someone who already knows his world.
Last intent: tuning AI Steve to feel more like him
Next action: answer naturally and with strong identity match
    `.trim();
  }

  return 'No caller-specific memory yet.';
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
      welcomeGreeting="yoo"
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

  const memoryContext = buildCallerMemoryContext(msg.from);
  const baseMessages = getBaseMessages(msg.from, msg.to, memoryContext);
  setConversation(callSid, baseMessages);

  console.log('ConversationRelay setup:', {
    callSid,
    from: msg.from,
    to: msg.to,
    memoryContext,
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
  const memoryContext = buildCallerMemoryContext('');
  setConversation(callSid, getBaseMessages('', '', memoryContext));
}

      const convo = getConversation(callSid) || {
  history: getBaseMessages('', '', buildCallerMemoryContext('')),
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
