require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// MEMORIA
const conversations = new Map();
const pedidos = new Map();
const MENU_CAFE = `
CAFÉ EL PUNTO

DESAYUNOS:
- Bowl de fruta — $89
- Chilaquiles — $140 (pollo o 2 huevos)
- Huevos al gusto — $139
- Baguette El Punto — $135
- Hotcakes — $130
- Omelette — $165

COMIDAS:
- Pasta El Punto — $160
- Lasagna — $195

ENSALADAS:
- Ensalada El Punto — $150
- Ensalada Verano — $160

PIZZAS:
- Pepperoni — $160
- Champiñón — $165
- Carnívora — $190
- Suprema — $190
- Camarón — $230

BEBIDAS:

LATTE (fríos o calientes):
- Chico — $60
- Grande — $70
- Jumbo — $79

EXTRAS DE SABOR:
- Chai (cualquier sabor) +$15
- Chai sucio +$20
- Matcha +$10
- Taro +$10
- Vainilla SF +$5
- Caramelo SF +$5

OTRAS BEBIDAS:
- Frappes $75–$89
- Café americano $30–$40
- Limonadas $40–$45
`;
const MENU_HAMBAS = `
HAMBAS URBAN FOOD

HAMBURGUESAS:
- Cheese Burger — $99
- Hambas Burger — $109
- Honey Burger — $119
- BBQ Spicy — $119
- Crispy Burger — $119
- Korean Chicken — $129
- Noro Burger — $149

🔥 ESPECIALES:
- Hamburguesa de carnitas + papas — $139
- Papas de carnitas — $139
- Mal del Puerco (res + carnitas) + papas — $180

EXTRAS:
- Carne extra +$30

COMBOS:
- Combo completo +$81 (papas + refresco + boneless)
- Combo antojo +$51 (papas + boneless)

BURRITOS:
- Bacon Cheese — $99
- Crispy Chicken — $119
- Chicken Parmesano — $119
- Burro Noro — $119

POLLO:
- Alitas — $139
- Boneless — $149

EXTRAS:
- Papas — $21
`;
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

  let menu = '';

  if (negocio === "Café El Punto") {
    menu = MENU_CAFE;
  }

  if (negocio === "Hambas Urban Food") {
    menu = MENU_HAMBAS;
  }

  return `
Eres el asistente de ${negocio}.

HORARIO:
7:00 AM a 10:30 PM
Domicilio: +$30

MENÚ:
${menu}

REGLAS:
- Responde en español
- Sé breve (máx 5 líneas)
- No inventes productos

VENTAS (IMPORTANTE):
- Sugiere extras (carne, combos, bebidas)
- Ofrece combos automáticamente
- Recomienda productos relacionados
- Siempre intenta cerrar la venta

PEDIDOS:
- Confirma cada producto con precio
- Sugiere agregar combo o extras
- Muestra subtotal
- Agrega envío $30
- Muestra TOTAL final
- Pide nombre, dirección y teléfono

OBJETIVO:
Vender y aumentar el ticket promedio.
`;
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
