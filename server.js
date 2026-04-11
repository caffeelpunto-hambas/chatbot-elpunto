require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const conversations = new Map();

// LIMPIAR SESIONES
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of conversations.entries()) {
    if (val.lastActivity < limite) conversations.delete(key);
  }
}, 30 * 60 * 1000);

// PROMPT DINÁMICO
function getSystemPrompt(negocio) {
  return `Eres el asistente virtual de "${negocio}".

Horario: 7:00 AM a 10:30 PM (todos los días)
Servicio a domicilio disponible (+$30 pesos)

Tu objetivo:
- Mostrar menú
- Resolver dudas
- Tomar pedidos

Reglas:
- Responde en español
- Sé breve (máx 5 líneas)
- Usa emojis con moderación
- NO inventes productos ni precios

Al tomar pedido:
- Confirma cada producto con precio
- Al final muestra resumen + TOTAL
- Agrega costo de envío ($30)
- Pide nombre, dirección y teléfono`;
}

// VERIFICACIÓN WEBHOOK
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// RECIBIR MENSAJES
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    let from = message.from;

    // Normalizar número MX
    if (from.startsWith('521') && from.length === 13) {
      from = '52' + from.slice(3);
    }

    const text = message.text.body.trim().toLowerCase();

    // CREAR SESIÓN
    if (!conversations.has(from)) {
      conversations.set(from, {
        messages: [],
        lastActivity: Date.now(),
        negocio: null
      });
    }

    const session = conversations.get(from);
    session.lastActivity = Date.now();

    // 🔥 PASO 1: SELECCIÓN DE NEGOCIO
    if (!session.negocio) {

      if (text.includes('cafe') || text.includes('punto') || text === '1') {
        session.negocio = "Café El Punto";
      } 
      else if (text.includes('hambas') || text.includes('burger') || text === '2') {
        session.negocio = "Hambas Urban Food";
      } 
      else {
        return await sendWhatsAppMessage(from,
`👋 ¡Hola! Bienvenido 🙌

¿En cuál deseas ordenar?

1️⃣ Café El Punto ☕
2️⃣ Hambas Urban Food 🍔

Responde con el número o nombre 👇`);
      }

      return await sendWhatsAppMessage(from,
`✅ Perfecto, elegiste *${session.negocio}* 😎

¿Te muestro el menú o deseas ordenar algo?`);
    }

    // 🔥 PASO 2: IA YA CON NEGOCIO SELECCIONADO
    session.messages.push({ role: 'user', content: text });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: getSystemPrompt(session.negocio),
      messages: session.messages
    });

    const reply = response.content[0].text;

    session.messages.push({ role: 'assistant', content: reply });

    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    await sendWhatsAppMessage(from, reply);

  } catch (err) {
    console.error('ERROR:', err.message);
  }
});

// ENVIAR MENSAJE
async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text }
    })
  });

  if (!res.ok) {
    console.error(await res.json());
    throw new Error('Error enviando mensaje');
  }
}

// ROOT
app.get('/', (req, res) => {
  res.send('✅ Chatbot activo');
});

// SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Servidor corriendo en puerto ${PORT}`);
});
