/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   CHATBOT WHATSAPP — CAFÉ EL PUNTO & HAMBAS BURGER          ║
 * ║   Powered by Claude + Meta WhatsApp Cloud API (GRATIS)       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const conversations = new Map();

setInterval(() => {
  const limite = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of conversations.entries()) {
    if (val.lastActivity < limite) conversations.delete(key);
  }
}, 30 * 60 * 1000);

const SYSTEM_PROMPT = `Eres el asistente virtual de "Café El Punto & Hambas Burger", un negocio en La Cruz, Elota, Sinaloa. Recibes mensajes por WhatsApp. Tu objetivo es ayudar a los clientes a conocer el menú, resolver dudas y tomar pedidos para entrega a domicilio.

HORARIOS:
- Desayunos: 7 AM a 1 PM
- Servicio a domicilio: 3 PM a 11 PM
- Teléfono del negocio: 696.688.1944
- Redes sociales: @CAFFEELPUNTO

MENÚ COMPLETO

CAFÉ EL PUNTO — DESAYUNOS (7am–1pm)
- Bowl de fruta — $89
- Chilaquiles — $140 (pollo o 2 huevos) | Extra machaca +$40 | Salsa: Roja, Verde o Mulata
- Combinación El Punto — $149
- Huevos al gusto — $139
- Baguette El Punto — $135 (jamón/pollo/machaca/champiñón) | Croissant +$10 | Extra +$30
- Baguette de Cochinita — $130
- Sandwich de quesos — $120
- Hotcakes — $130 (2 piezas) / $90 (1 pieza)
- Enchiladas Sureñas — $160
- Combinación Norteña — $190
- Omelettes — $165

CAFÉ EL PUNTO — COMIDAS (todo el día)
- Baguette El Punto $135 | Baguette Cochinita $135 | Baguette al Pesto $145 | Sandwich de quesos $120
- Pasta El Punto: Con Pollo $160 | Con Champiñón $150 | Con Camarón $190
- Ensalada El Punto $150 | Ensalada Verano $160 | Lasagna de Res $195
- Nachos El Punto $140 | Tostinachos $160
- Pizzas: Pepperoni $160 | Champiñón $165 | Carnívora $190 | Suprema $190 | Camarón $230

HAMBAS BURGER — DESAYUNOS
- Combinación Hambas $140 | Combinación Sandwich de queso $110 | Omelette $139
- Lo dulce: Kekis $99 | Hot Cakes $120 | Pan Francés $140

HAMBAS BURGER — HAMBURGUESAS
- Cheese Burger $99 | Hambas Burger $109 | Honey Burger $119
- BBQ Spicy $119 | Crispy Burger $119 | Korean Chicken $129 | Noro Burger $149
- Extras: Papas $21 | Boneless $51 | Combo $81

HAMBAS BURGER — BURRITOS
- Bacon Cheese $99 | Crispy Chicken $119 | Chicken Parmesano $119 | Burro Noro $119

HAMBAS BURGER — POLLO
- Alitas $139 | Boneless $149 | Milanesa con papas $129 | Ensalada Crispy $129

HAMBAS BURGER — NIÑOS
- Hambitas Box $139 | Hambitas Burger $79 | Nuggets $99 | Waffle $99

BEBIDAS
FRAPPE: Grande 16oz $75 | Jumbo 24oz $89
FRÍAS: Grande 16oz $60 | Jumbo 24oz $79
CALIENTES: Chico 12oz $55 | Grande 16oz $70 | Jumbo 24oz $79
CAFÉ DEL DÍA: Chico $30 | Grande $35 | Jumbo $40 | Refill $40
Sabores: Regular, Oreo(+$10), Caramelo, Vainilla, Moka, Avellana, Crema Irlandesa, Chocolate Blanco, Americano Limón, Matcha(+$10), Lavanda, Ferrero/Nutella(+$15), Honey, Fresa, Frutos Rojos, Taro(+$10), Chai(+$15), Chai Vainilla(+$15), Tisana, Chai Sucio(+$20)
Sugar Free: Vainilla SF(+$5), Caramelo SF(+$5), Kombucha, Chai SF(+$15)
Otras: Jugo Naranja/Verde $40 | Malteada Fresa $60 | Malteada Chocolate $60
Limonada $40 | Limonada Mineral $45 | Té Jamaica $45 | Té Jazmín $40
Refresco $40 | Agua Natural $25 | Agua Mineral $35

INSTRUCCIONES:
1. Responde SIEMPRE en español. Sé amable y usa emojis con moderación.
2. Respuestas CORTAS (máx 5-7 líneas) — es WhatsApp.
3. Al tomar pedido: confirma cada item con precio. Al terminar, pide nombre, dirección y teléfono.
4. Al finalizar muestra RESUMEN con productos y TOTAL en pesos mexicanos.
5. Avisa si piden fuera de horario.
6. NO inventes precios ni productos.
7. Dudas: da el teléfono 696.688.1944.`;

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const from = message.from;
    const text = message.text.body.trim();
    const phoneNumberId = req.body.entry[0].changes[0].value.metadata.phone_number_id;
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
    if (session.messages.length > 20) session.messages = session.messages.slice(-20);
    await sendWhatsAppMessage(phoneNumberId, from, reply);
    if (esPedidoCompleto(reply) && process.env.OWNER_PHONE) {
      const resumen = `🔔 *NUEVO PEDIDO*\nCliente: +${from}\n━━━━━━━━━━━━━━━━━\n${reply}\n🕐 ${new Date().toLocaleString('es-MX')}`;
      await sendWhatsAppMessage(phoneNumberId, process.env.OWNER_PHONE, resumen);
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
});

async function sendWhatsAppMessage(phoneNumberId, to, text) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
  if (!res.ok) throw new Error(`Meta API error: ${JSON.stringify(await res.json())}`);
}

function esPedidoCompleto(text) {
  return ['total:', 'total es', 'resumen del pedido', 'tu pedido:'].some(kw => text.toLowerCase().includes(kw));
}

app.get('/', (req, res) => {
  res.json({ status: '✅ Chatbot activo', negocio: 'Café El Punto & Hambas Burger' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Chatbot corriendo en puerto ${PORT}`));
