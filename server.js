import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { PORT = '3000' } = process.env;

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

function sendVoiceTest(res) {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">yo what up, this is a voice test.</Say>
  <Pause length="2"/>
</Response>`);
}

app.get('/voice', (_req, res) => {
  sendVoiceTest(res);
});

app.post('/voice', (_req, res) => {
  sendVoiceTest(res);
});

app.listen(Number(PORT), () => {
  console.log(`Voice test server listening on :${PORT}`);
});
