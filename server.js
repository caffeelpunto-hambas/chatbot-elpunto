require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const conversations = new Map();

// Limpieza de sesiones
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of conversations.entries()) {
    if (val.lastActivity < limite) conversations.delete(key);
  }
}, 30 * 60 * 1000);

// PROMPT
const SYSTEM_PROMPT = `Eres el asistente virtual de 2 negocios diferente "Café El Punto" y "Hambas Burger", 2 negocios en La Cruz, Elota, Sinaloa. Responde por WhatsApp de forma clara, amable y breve (máx 5-7 líneas). Usa emojis con moderación.

Ayuda a:
- primero pregunta a cual de los 2 negocios desea ordenar
- Mostrar menú del negocio solicitado
- Resolver dudas
- Tomar pedidos

Al tomar pedido:
- Confirma productos con precio
- Al final muestra resumen con TOTAL
- Pide nombre, dirección y teléfono

Horarios:
- Desayunos: 7 AM a 3 PM
- Resto del Menú: de 7 AM a 10:30 PM
- Domicilio: 7 AM a 10:30 PM

Teléfono: 6966881944
Instagram: @CAFFEELPUNTO

NO inventes precios.`;

// WEBHOOK VERIFY
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// WEBHOOK RECEIVE
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

    const text = message.text.body.trim();

    if (!conversations.has(from)) {
      conversations.set(from, { messages: [], lastActivity: Date.now() });
    }

    const session = conversations.get(from);
    session.lastActivity = Date.now();
    session.messages.push({ role: 'user', content: text });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: session.messages
    });

    const reply = response.content[0].text;
    session.messages.push({ role: 'assistant', content: reply });

    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    // RESPUESTA AL CLIENTE
    await sendWhatsAppMessage(from, reply);

    // ENVÍO AL DUEÑO SI ES PEDIDO
    if (esPedidoCompleto(reply) && process.env.OWNER_PHONE) {
      const resumen = `🔔 *NUEVO PEDIDO*\nCliente: +${from}\n━━━━━━━━━━━━━━━━━\n${reply}\n🕐 ${new Date().toLocaleString('es-MX')}`;
      await sendWhatsAppMessage(process.env.OWNER_PHONE, resumen);
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
});

// FUNCIÓN CORRECTA PARA ENVIAR MENSAJES
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
    throw new Error(`Error API Meta: ${JSON.stringify(await res.json())}`);
  }
}

// DETECTAR PEDIDO COMPLETO
function esPedidoCompleto(text) {
  return ['total:', 'total es', 'resumen del pedido', 'tu pedido:']
    .some(kw => text.toLowerCase().includes(kw));
}

// ROOT
app.get('/', (req, res) => {
  res.json({ status: '✅ Chatbot activo' });
});

// SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});
