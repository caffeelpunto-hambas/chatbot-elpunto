require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// MEMORIA
const conversations = new Map();
const pedidos = new Map();

// CARGAR MENÚ DESDE menu.json
function cargarMenu() {
  const rutaMenu = path.join(__dirname, 'menu.json');
  const raw = fs.readFileSync(rutaMenu, 'utf-8');
  return JSON.parse(raw);
}

// FORMATEAR MENÚ PARA EL PROMPT
function formatearMenu(negocio) {
  const menus = cargarMenu();
  const data = menus[negocio];
  if (!data) return 'Menú no disponible.';

  let texto = `${negocio.toUpperCase()}\n`;

  for (const [categoria, items] of Object.entries(data.categorias)) {
    texto += `\n${categoria}:\n`;

    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.precio_extra !== undefined) {
          texto += `- ${item.nombre} +$${item.precio_extra}`;
        } else {
          texto += `- ${item.nombre} — $${item.precio}`;
        }
        if (item.descripcion) {
          texto += `\n  (${item.descripcion})`;
        }
        texto += '\n';
      }
    } else if (typeof items === 'object') {
      for (const [sub, subitems] of Object.entries(items)) {
        if (sub === 'descripcion_latte') continue;
        if (Array.isArray(subitems)) {
          texto += `\n  ${sub}:\n`;
          for (const item of subitems) {
            if (typeof item === 'string') {
              texto += `  - ${item}\n`;
            } else if (item.precio_extra !== undefined) {
              texto += `  - ${item.nombre} +$${item.precio_extra}\n`;
            } else if (item.precio !== undefined) {
              texto += `  - ${item.nombre} — $${item.precio}`;
              if (item.descripcion) texto += ` (${item.descripcion})`;
              texto += '\n';
            }
          }
        }
      }
    }
  }

  return texto;
}

// PROMPT DINÁMICO
function getSystemPrompt(negocio) {
  const menu = formatearMenu(negocio);

  // Definir productos clave del otro restaurante para que Claude los reconozca
  const otroRestaurante = negocio === "Café El Punto"
    ? "Hambas Urban Food"
    : "Café El Punto";

  const productosOtro = negocio === "Café El Punto"
    ? "hamburguesas, hambas burger, crispy burger, korean chicken, noro burger, bbq spicy, honey burger, cheese burger, burritos, alitas, boneless, mal del puerco, papas de carnitas, carnitas"
    : "pizza, chilaquiles, hotcakes, omelette, ensalada, pasta, lasagna, baguette, bowl de fruta, huevos al gusto, nachos, postre, pan dulce, galleta, pastel, desayuno";

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
- No inventes productos que no están en el menú de ${negocio}
- Cuando describas un platillo, usa la descripción del menú para hacerlo sonar tentador
- Si el cliente pregunta qué recomiendas, sugiere los platillos con descripción más atractiva

OTRO RESTAURANTE DEL GRUPO:
- El grupo también cuenta con *${otroRestaurante}*, que vende: ${productosOtro}.
- Si el cliente pide algo que SOLO vende ${otroRestaurante} y que NO está en el menú de ${negocio}:
  * Escribe [SWITCH:${otroRestaurante}] al inicio de tu respuesta (el sistema lo procesa, el cliente no lo ve)
  * Si el cliente ya tiene productos en el pedido actual: dile amablemente que ese producto es de ${otroRestaurante}, que terminas de tomar su pedido actual y luego levantas uno allá
  * Si el cliente aún no ha pedido nada: dile que ese producto es de ${otroRestaurante} y que con gusto lo pasas ahí
- NUNCA digas que tienes productos que no están en tu menú

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

// DETECTAR MARCADOR DE CAMBIO DE RESTAURANTE
function detectarSwitch(text) {
  const match = text.match(/\[SWITCH:([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

// LIMPIAR MARCADORES INTERNOS ANTES DE ENVIAR AL CLIENTE
function limpiarMarcadores(text) {
  return text.replace(/\[SWITCH:[^\]]+\]/g, '').trim();
}

// LIMPIAR SESIONES VIEJAS
setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of conversations.entries()) {
    if (val.lastActivity < limite) conversations.delete(key);
  }
  for (const [id, pedido] of pedidos.entries()) {
    if (pedido.timestamp < limite) pedidos.delete(id);
  }
}, 30 * 60 * 1000);

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

    // MENSAJES DE COCINA
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
        negocio: null,
        pendingSwitch: null  // restaurante al que cambiará después del pedido actual
      });
    }
    const session = conversations.get(from);
    session.lastActivity = Date.now();

    // SELECCIÓN DE NEGOCIO
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

    // IA CON REINTENTO AUTOMÁTICO
    session.messages.push({ role: 'user', content: text });

    let response;
    let intentos = 0;
    const maxIntentos = 3;

    while (intentos < maxIntentos) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 300,
          system: getSystemPrompt(session.negocio),
          messages: session.messages
        });
        break;
      } catch (err) {
        intentos++;
        if (err.status === 529 && intentos < maxIntentos) {
          await new Promise(r => setTimeout(r, 2000 * intentos));
        } else {
          throw err;
        }
      }
    }

    const replyRaw = response.content[0].text;

    // Detectar si Claude quiere hacer un cambio de restaurante
    const switchTarget = detectarSwitch(replyRaw);

    // Limpiar marcadores internos antes de enviar al cliente
    const reply = limpiarMarcadores(replyRaw);

    session.messages.push({ role: 'assistant', content: reply });

    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    await sendWhatsAppMessage(from, reply);

    // MANEJAR CAMBIO DE RESTAURANTE
    if (switchTarget) {
      const tieneConversacion = session.messages.length > 2;

      if (!tieneConversacion) {
        // Sin pedido activo: cambiar de restaurante de inmediato
        session.negocio = switchTarget;
        session.messages = [];
        session.pendingSwitch = null;
        await sendWhatsAppMessage(from,
          `✅ Te paso a *${switchTarget}* 😎\n¿Qué deseas ordenar?`
        );
      } else {
        // Hay conversación activa: guardar el switch para después del pedido
        session.pendingSwitch = switchTarget;
      }
    }

    // DETECTAR PEDIDO COMPLETO Y ENVIAR A COCINA
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
      if (session.negocio === "Café El Punto") destino = process.env.CAFE_PHONE;
      if (session.negocio === "Hambas Urban Food") destino = process.env.HAMBAS_PHONE;

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

      // Si hay un cambio de restaurante pendiente, ejecutarlo ahora
      if (session.pendingSwitch) {
        const nuevoNegocio = session.pendingSwitch;
        session.pendingSwitch = null;
        session.negocio = nuevoNegocio;
        session.messages = [];

        await sendWhatsAppMessage(from,
`✅ ¡Listo! Tu pedido quedó registrado 🙌
Ahora te atiendo en *${nuevoNegocio}* 😎
¿Qué deseas ordenar?`
        );
      }
    }

  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.status === 529) {
      try {
        const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        if (from) {
          await sendWhatsAppMessage(from,
            '⏳ Estamos con mucha demanda en este momento, intenta de nuevo en unos segundos 🙏'
          );
        }
      } catch (_) {}
    }
  }
});

// ENVIAR MENSAJE WHATSAPP
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

// DETECTAR PEDIDO COMPLETO
function esPedidoCompleto(text) {
  return ['total', 'pedido', 'resumen']
    .some(p => text.toLowerCase().includes(p));
}

// ENDPOINT ADMIN — VER MENÚ EN VIVO
app.get('/admin/menu', (req, res) => {
  const token = req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  try {
    const menu = cargarMenu();
    res.json({ ok: true, menu });
  } catch (e) {
    res.status(500).json({ error: 'Error leyendo menu.json', detalle: e.message });
  }
});

// ROOT
app.get('/', (req, res) => {
  res.send('✅ Chatbot activo');
});

// SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Servidor corriendo en puerto ${PORT}`);
});
