require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// MEMORIA
const conversations = new Map();
const pedidos = new Map();

// LIMPIAR SESIONES
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;

  for (const [key, val] of conversations.entries()) {
    if (val.lastActivity < limite) conversations.delete(key);
  }

  for (const [id, pedido] of pedidos.entries()) {
    if (pedido.timestamp < limite) pedidos.delete(id);
  }

}, 30 * 60 * 1000);

// PROMPT DINÁMICO
function getSystemPrompt(negocio) {
  return `Eres el asistente virtual de "${negocio}".

Horario: 7:00 AM a 10:30 PM
Servicio a domicilio: +$30 pesos

Responde en español, breve y claro.

Tu objetivo:
- Mostrar menú
- Tomar pedidos

Al tomar pedido:
- Confirma productos con precio
- Muestra TOTAL
- Incluye envío $30
- Pide nombre, dirección y teléfono

NO inventes productos ni precios.`;
}

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

// WEBHOOK MENSAJES
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    let from = message.from;

    // Normalizar MX
    if (from.startsWith('521') && from.length === 13) {
      from = '52' + from.slice(3);
    }

    const text = message.text.body.trim().toLowerCase();

    // 🔥 MENSAJES DE COCINA
    if (
      from === process.env.CAFE_PHONE ||
      from === process.env.HAMBAS_PHONE
    ) {

      const partes = text.split(' ');
      const comando = partes[0];
      const pedidoId = partes[1];

      if (!pedidoId || !pedidos.has(pedidoId)) return;

      const pedido = pedidos.get(pedidoId);

      if (comando === 'confirmar') {
        pedido.estado = 'confirmado';

        await sendWhatsAppMessage(
          pedido.cliente,
          `✅ Tu pedido fue confirmado 👨‍🍳\n\nYa estamos preparándolo 🙌`
        );
      }

      if (comando === 'listo') {
        pedido.estado = 'listo';

        await sendWhatsAppMessage(
          pedido.cliente,
          `🍔 Tu pedido está listo 😎\n\n¡Gracias por tu compra! 🙌`
        );
      }

      return;
    }

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

    // 🔥 SELECCIÓN DE NEGOCIO
    if (!session.negocio) {

      if (text.includes('cafe') || text === '1') {
        session.negocio = "Café El Punto";
      } else if (text.includes('hambas') || text === '2') {
        session.negocio = "Hambas Urban Food";
      } else {
        return await sendWhatsAppMessage(from,
`👋 ¡Hola! Bienvenido 🙌

¿Dónde deseas ordenar?

1️⃣ Café El Punto ☕
2️⃣ Hambas Urban Food 🍔

Responde con el número o nombre 👇`);
      }

      return await sendWhatsAppMessage(from,
`✅ Elegiste *${session.negocio}* 😎

¿Te muestro el menú o deseas ordenar?`);
    }

    // IA
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

    // 🔥 DETECTAR PEDIDO
    if (esPedidoCompleto(reply)) {

      const pedidoId = Date.now().toString();

      pedidos.set(pedidoId, {
        cliente: from,
        negocio: session.negocio,
        contenido: reply,
        estado: 'pendiente',
        timestamp: Date.now()
      });

      let destino = null;

      if (session.negocio === "Café El Punto") {
        destino = process.env.CAFE_PHONE;
      }

      if (session.negocio === "Hambas Urban Food") {
        destino = process.env.HAMBAS_PHONE;
      }

      if (destino) {
        const mensaje = `🔥 NUEVO PEDIDO #${pedidoId}

Cliente: +${from}
━━━━━━━━━━━━━━
${reply}
━━━━━━━━━━━━━━

Responde:
CONFIRMAR ${pedidoId}
LISTO ${pedidoId}`;

        await sendWhatsAppMessage(destino, mensaje);
      }
    }

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

// DETECTAR PEDIDO
function esPedidoCompleto(text) {
  return ['total', 'pedido', 'resumen']
    .some(p => text.toLowerCase().includes(p));
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
