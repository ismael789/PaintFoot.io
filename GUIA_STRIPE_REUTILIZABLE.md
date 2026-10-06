# Integración reutilizable de Stripe Checkout

Esta guía contiene solamente la integración de Stripe. La lógica usa una entidad genérica llamada `orden`, para que pueda adaptarse a ventas, reservaciones, servicios, cursos u otro proyecto.

La integración utiliza **Stripe Checkout alojado por Stripe**. El frontend nunca recibe la clave secreta ni datos de tarjeta: solicita una sesión al backend y redirige al usuario a `session.url`.

## 1. Flujo completo

1. El frontend llama a `POST /api/stripe/checkout` con el identificador de una orden.
2. El backend obtiene la orden desde la base de datos y calcula el importe. Nunca acepta el precio enviado por el navegador.
3. El backend crea una sesión de Stripe Checkout.
4. Stripe devuelve `session.id` y `session.url`.
5. El frontend redirige al usuario a `session.url`.
6. Stripe procesa la tarjeta.
7. Stripe envía un webhook firmado al backend.
8. El backend verifica la firma, el importe, la moneda y la orden.
9. El backend marca la orden como pagada dentro de una transacción.
10. Stripe redirige al usuario a la pantalla de éxito.

La redirección de éxito es únicamente visual. El webhook es quien debe confirmar definitivamente el pago.

## 2. Instalación

En el backend:

```bash
npm install express dotenv stripe mysql2
```

Para desarrollo local también puede instalarse Stripe CLI desde la página oficial de Stripe.

## 3. Variables de entorno

Crear `server/.env` y mantenerlo fuera de Git:

```env
PORT=4000
NODE_ENV=development

STRIPE_SECRET_KEY=sk_test_REEMPLAZAR
STRIPE_WEBHOOK_SECRET=whsec_REEMPLAZAR
STRIPE_CURRENCY=mxn

FRONTEND_URL=http://localhost:5173

MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASS=
MYSQL_DB=nombre_base_datos
```

Reglas importantes:

- `STRIPE_SECRET_KEY` solo puede existir en el backend.
- `STRIPE_WEBHOOK_SECRET` pertenece al endpoint de webhook; no es la misma clave que `STRIPE_SECRET_KEY`.
- No copiar claves de prueba `sk_test_...` a producción.
- Si dos proyectos usan la misma cuenta Stripe, conviene crear endpoints de webhook separados y, cuando sea posible, claves restringidas distintas.
- Con Checkout mediante `session.url` no es necesaria una clave pública en React.

## 4. Tablas mínimas

La tabla `ordenes` representa la entidad comercial del nuevo proyecto. Puede cambiarse el nombre, pero el backend necesita como mínimo el propietario, total, moneda y estado.

```sql
CREATE TABLE ordenes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  moneda CHAR(3) NOT NULL DEFAULT 'MXN',
  estado ENUM('pendiente_pago', 'pagada', 'pago_fallido', 'cancelada')
    NOT NULL DEFAULT 'pendiente_pago',
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Cada intento de Checkout se registra por separado:

```sql
CREATE TABLE intentos_pago_stripe (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  orden_id BIGINT UNSIGNED NOT NULL,
  stripe_session_id VARCHAR(255) NOT NULL,
  stripe_payment_intent_id VARCHAR(255) DEFAULT NULL,
  checkout_url TEXT DEFAULT NULL,
  monto_centavos BIGINT UNSIGNED NOT NULL,
  moneda CHAR(3) NOT NULL,
  estado ENUM(
    'abierto',
    'pagado',
    'fallido',
    'expirado',
    'importe_incorrecto'
  ) NOT NULL DEFAULT 'abierto',
  expira_en DATETIME DEFAULT NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stripe_session (stripe_session_id),
  KEY idx_intento_orden_estado (orden_id, estado),
  CONSTRAINT fk_intento_orden
    FOREIGN KEY (orden_id) REFERENCES ordenes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## 5. Cliente de base de datos

Archivo `server/db.js`:

```js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
});

module.exports = pool;
```

## 6. Cliente Stripe

Archivo `server/stripe.js`:

```js
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY no está configurada');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = stripe;
```

No es necesario fijar manualmente `apiVersion` salvo que el proyecto tenga una razón concreta para hacerlo. La versión se administra desde la cuenta y la versión compatible con el SDK instalado.

## 7. Controlador completo

Archivo `server/controllers/stripeController.js`:

```js
const pool = require('../db');
const stripe = require('../stripe');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const CURRENCY = (process.env.STRIPE_CURRENCY || 'mxn').toLowerCase();

function convertirACentavos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new Error('El total de la orden no es válido');
  }
  return Math.round(numero * 100);
}

async function buscarOrden(ordenId, usuarioId) {
  const [rows] = await pool.query(
    `SELECT id, usuario_id, total, moneda, estado
     FROM ordenes
     WHERE id = ? AND usuario_id = ?
     LIMIT 1`,
    [ordenId, usuarioId]
  );
  return rows[0] || null;
}

async function buscarSesionAbierta(ordenId) {
  const [rows] = await pool.query(
    `SELECT stripe_session_id, checkout_url
     FROM intentos_pago_stripe
     WHERE orden_id = ? AND estado = 'abierto'
     ORDER BY id DESC
     LIMIT 1`,
    [ordenId]
  );

  if (!rows[0]) return null;

  try {
    const session = await stripe.checkout.sessions.retrieve(
      rows[0].stripe_session_id
    );

    if (session.status === 'open' && session.url) {
      return session;
    }

    await pool.query(
      `UPDATE intentos_pago_stripe
       SET estado = ?
       WHERE stripe_session_id = ? AND estado = 'abierto'`,
      [session.status === 'expired' ? 'expirado' : 'fallido', session.id]
    );
  } catch (error) {
    console.error('[STRIPE] No se pudo recuperar la sesión:', error.message);
  }

  return null;
}

async function crearCheckout(req, res) {
  try {
    const usuarioId = req.user.id;
    const ordenId = Number(req.body.orden_id);

    if (!Number.isInteger(ordenId) || ordenId <= 0) {
      return res.status(400).json({ error: 'orden_id no válido' });
    }

    const orden = await buscarOrden(ordenId, usuarioId);

    if (!orden) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    if (orden.estado === 'pagada') {
      return res.status(409).json({ error: 'La orden ya está pagada' });
    }

    if (orden.estado !== 'pendiente_pago') {
      return res.status(409).json({
        error: `No se puede pagar una orden en estado ${orden.estado}`,
      });
    }

    const sesionExistente = await buscarSesionAbierta(orden.id);
    if (sesionExistente) {
      return res.json({
        session_id: sesionExistente.id,
        url: sesionExistente.url,
        reutilizada: true,
      });
    }

    const montoCentavos = convertirACentavos(orden.total);
    const moneda = (orden.moneda || CURRENCY).toLowerCase();

    // Se cobra el total final de la base de datos en una sola línea.
    // Así no se pierde IVA, descuentos, comisiones u otros conceptos.
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        client_reference_id: String(orden.id),
        line_items: [
          {
            price_data: {
              currency: moneda,
              product_data: {
                name: `Orden #${orden.id}`,
              },
              unit_amount: montoCentavos,
            },
            quantity: 1,
          },
        ],
        metadata: {
          orden_id: String(orden.id),
          usuario_id: String(usuarioId),
        },
        payment_intent_data: {
          metadata: {
            orden_id: String(orden.id),
            usuario_id: String(usuarioId),
          },
        },
        success_url:
          `${FRONTEND_URL}/pago/exito?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/pago/cancelado?orden_id=${orden.id}`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      {
        // Repetir la solicitud para la misma orden devuelve la misma creación
        // en lugar de generar cobros duplicados.
        idempotencyKey: `checkout_orden_${orden.id}`,
      }
    );

    await pool.query(
      `INSERT INTO intentos_pago_stripe
         (orden_id, stripe_session_id, checkout_url, monto_centavos,
          moneda, estado, expira_en)
       VALUES (?, ?, ?, ?, ?, 'abierto', FROM_UNIXTIME(?))
       ON DUPLICATE KEY UPDATE
         checkout_url = VALUES(checkout_url),
         actualizado_en = NOW()`,
      [
        orden.id,
        session.id,
        session.url,
        montoCentavos,
        moneda.toUpperCase(),
        session.expires_at,
      ]
    );

    return res.json({
      session_id: session.id,
      url: session.url,
      reutilizada: false,
    });
  } catch (error) {
    console.error('[STRIPE] Error creando Checkout:', error);
    return res.status(500).json({
      error: 'No se pudo iniciar el pago',
    });
  }
}

async function confirmarSesionPagada(session) {
  if (session.payment_status !== 'paid') {
    return { procesada: false, motivo: 'pago_no_confirmado' };
  }

  const ordenId = Number(
    session.metadata?.orden_id || session.client_reference_id
  );

  if (!Number.isInteger(ordenId) || ordenId <= 0) {
    throw new Error(`Sesión ${session.id} sin orden_id válido`);
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [ordenes] = await conn.query(
      `SELECT id, total, moneda, estado
       FROM ordenes
       WHERE id = ?
       FOR UPDATE`,
      [ordenId]
    );

    const orden = ordenes[0];
    if (!orden) {
      throw new Error(`Orden ${ordenId} no encontrada`);
    }

    const montoEsperado = convertirACentavos(orden.total);
    const monedaEsperada = String(orden.moneda).toLowerCase();
    const monedaRecibida = String(session.currency).toLowerCase();

    if (
      session.amount_total !== montoEsperado ||
      monedaRecibida !== monedaEsperada
    ) {
      await conn.query(
        `UPDATE intentos_pago_stripe
         SET estado = 'importe_incorrecto',
             stripe_payment_intent_id = ?
         WHERE stripe_session_id = ?`,
        [session.payment_intent || null, session.id]
      );
      await conn.commit();
      return { procesada: false, motivo: 'importe_incorrecto' };
    }

    // Idempotencia: el mismo webhook puede llegar varias veces.
    if (orden.estado === 'pagada') {
      await conn.query(
        `UPDATE intentos_pago_stripe
         SET estado = 'pagado', stripe_payment_intent_id = ?
         WHERE stripe_session_id = ?`,
        [session.payment_intent || null, session.id]
      );
      await conn.commit();
      return { procesada: true, repetida: true, orden_id: ordenId };
    }

    if (orden.estado !== 'pendiente_pago') {
      await conn.rollback();
      return { procesada: false, motivo: `estado_${orden.estado}` };
    }

    const [actualizacion] = await conn.query(
      `UPDATE ordenes
       SET estado = 'pagada', actualizado_en = NOW()
       WHERE id = ? AND estado = 'pendiente_pago'`,
      [ordenId]
    );

    if (actualizacion.affectedRows !== 1) {
      throw new Error('La orden cambió de estado durante la confirmación');
    }

    await conn.query(
      `UPDATE intentos_pago_stripe
       SET estado = 'pagado', stripe_payment_intent_id = ?
       WHERE stripe_session_id = ?`,
      [session.payment_intent || null, session.id]
    );

    // Aquí se ejecuta la lógica particular del nuevo proyecto:
    // - reservar una cita;
    // - habilitar un curso;
    // - descontar inventario;
    // - generar una licencia;
    // - emitir una notificación.
    // Debe permanecer dentro de esta misma transacción.

    await conn.commit();
    return { procesada: true, repetida: false, orden_id: ordenId };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function marcarSesionFallida(objeto, estado) {
  const sessionId = objeto.object === 'checkout.session' ? objeto.id : null;
  const paymentIntentId =
    objeto.object === 'payment_intent' ? objeto.id : objeto.payment_intent;
  const ordenId = Number(objeto.metadata?.orden_id);

  if (sessionId) {
    await pool.query(
      `UPDATE intentos_pago_stripe
       SET estado = ?, stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id)
       WHERE stripe_session_id = ? AND estado = 'abierto'`,
      [estado, paymentIntentId || null, sessionId]
    );
  } else if (paymentIntentId) {
    await pool.query(
      `UPDATE intentos_pago_stripe
       SET estado = ?
       WHERE stripe_payment_intent_id = ? AND estado = 'abierto'`,
      [estado, paymentIntentId]
    );
  }

  if (Number.isInteger(ordenId) && ordenId > 0) {
    await pool.query(
      `UPDATE ordenes
       SET estado = 'pago_fallido'
       WHERE id = ? AND estado = 'pendiente_pago'`,
      [ordenId]
    );
  }
}

async function webhookStripe(req, res) {
  const firma = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(500).json({ error: 'Webhook no configurado' });
  }

  let evento;

  try {
    evento = stripe.webhooks.constructEvent(
      req.body,
      firma,
      webhookSecret
    );
  } catch (error) {
    console.error('[STRIPE] Firma inválida:', error.message);
    return res.status(400).json({ error: 'Firma inválida' });
  }

  try {
    switch (evento.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await confirmarSesionPagada(evento.data.object);
        break;

      case 'checkout.session.expired':
        await marcarSesionFallida(evento.data.object, 'expirado');
        break;

      case 'checkout.session.async_payment_failed':
      case 'payment_intent.payment_failed':
        await marcarSesionFallida(evento.data.object, 'fallido');
        break;

      default:
        console.log('[STRIPE] Evento ignorado:', evento.type);
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('[STRIPE] Error procesando webhook:', error);
    // Un 500 hace que Stripe vuelva a intentar entregar el evento.
    return res.status(500).json({ error: 'Error procesando webhook' });
  }
}

async function obtenerEstadoSesion(req, res) {
  try {
    const usuarioId = req.user.id;
    const sessionId = req.params.sessionId;

    const [rows] = await pool.query(
      `SELECT
         i.stripe_session_id,
         i.estado AS estado_pago,
         i.monto_centavos,
         i.moneda,
         o.id AS orden_id,
         o.total,
         o.estado AS estado_orden
       FROM intentos_pago_stripe i
       JOIN ordenes o ON o.id = i.orden_id
       WHERE i.stripe_session_id = ? AND o.usuario_id = ?
       LIMIT 1`,
      [sessionId, usuarioId]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    return res.json(rows[0]);
  } catch (error) {
    console.error('[STRIPE] Error consultando sesión:', error);
    return res.status(500).json({ error: 'No se pudo consultar el pago' });
  }
}

module.exports = {
  crearCheckout,
  webhookStripe,
  obtenerEstadoSesion,
};
```

## 8. Rutas

El webhook debe usar `express.raw()`.

Archivo `server/routes/stripeWebhookRouter.js`:

```js
const express = require('express');
const { webhookStripe } = require('../controllers/stripeController');

const router = express.Router();

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  webhookStripe
);

module.exports = router;
```

Las operaciones iniciadas por el usuario sí requieren autenticación.

Archivo `server/routes/stripeRouter.js`:

```js
const express = require('express');
const {
  crearCheckout,
  obtenerEstadoSesion,
} = require('../controllers/stripeController');
const { verificarToken } = require('../middleware/auth');

const router = express.Router();

router.use(verificarToken);
router.post('/checkout', crearCheckout);
router.get('/sesion/:sessionId', obtenerEstadoSesion);

module.exports = router;
```

## 9. Orden obligatorio en Express

Archivo `server/index.js`:

```js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config({ path: __dirname + '/.env' });

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));

// IMPORTANTE: el webhook va antes de express.json().
// Si express.json() procesa primero el cuerpo, la firma deja de ser válida.
app.use(
  '/api/stripe/webhook',
  require('./routes/stripeWebhookRouter')
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/stripe', require('./routes/stripeRouter'));

app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
  console.log(
    `Webhook Stripe: http://localhost:${PORT}/api/stripe/webhook`
  );
});
```

Arranque del backend:

```bash
node server/index.js
```

O con un script:

```json
{
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js"
  }
}
```

## 10. Servicio del frontend

Archivo `src/services/stripe.js`:

```js
const API_URL = import.meta.env.VITE_API_URL || '/api';

function headers() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function leerJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Error procesando el pago');
  }
  return data;
}

export async function iniciarCheckout(ordenId) {
  const response = await fetch(`${API_URL}/stripe/checkout`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ orden_id: ordenId }),
  });
  return leerJson(response);
}

export async function obtenerEstadoPago(sessionId) {
  const response = await fetch(
    `${API_URL}/stripe/sesion/${encodeURIComponent(sessionId)}`,
    { headers: headers() }
  );
  return leerJson(response);
}
```

## 11. Botón de pago

```jsx
import { useState } from 'react';
import { iniciarCheckout } from './services/stripe';

export default function BotonPagar({ ordenId }) {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  async function pagar() {
    setCargando(true);
    setError('');

    try {
      const checkout = await iniciarCheckout(ordenId);
      window.location.assign(checkout.url);
    } catch (err) {
      setError(err.message);
      setCargando(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={pagar} disabled={cargando}>
        {cargando ? 'Abriendo Stripe…' : 'Pagar con tarjeta'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
```

## 12. Pantalla de éxito

La página consulta el estado registrado por el webhook. No debe marcar la orden como pagada desde React.

```jsx
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { obtenerEstadoPago } from './services/stripe';

export default function PagoExitoso() {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id');
  const [estado, setEstado] = useState({ cargando: true });

  useEffect(() => {
    if (!sessionId) {
      setEstado({ cargando: false, error: 'Falta session_id' });
      return;
    }

    let cancelado = false;
    let intentos = 0;

    async function consultar() {
      try {
        const data = await obtenerEstadoPago(sessionId);
        if (cancelado) return;

        if (data.estado_orden === 'pagada') {
          setEstado({ cargando: false, data });
          return;
        }

        intentos += 1;
        if (intentos < 10) {
          setTimeout(consultar, 2000);
        } else {
          setEstado({
            cargando: false,
            pendiente: true,
            data,
          });
        }
      } catch (error) {
        if (!cancelado) {
          setEstado({ cargando: false, error: error.message });
        }
      }
    }

    consultar();
    return () => {
      cancelado = true;
    };
  }, [sessionId]);

  if (estado.cargando) return <p>Confirmando el pago…</p>;
  if (estado.error) return <p>{estado.error}</p>;
  if (estado.pendiente) return <p>El pago continúa en confirmación.</p>;

  return <h1>Pago confirmado para la orden #{estado.data.orden_id}</h1>;
}
```

## 13. Webhook local con Stripe CLI

Terminal 1, backend:

```bash
npm run dev
```

Terminal 2, autenticación de Stripe CLI:

```bash
stripe login
```

Terminal 2, reenvío de eventos:

```bash
stripe listen --forward-to localhost:4000/api/stripe/webhook
```

Stripe CLI mostrará un valor `whsec_...`. Ese valor debe copiarse temporalmente a `STRIPE_WEBHOOK_SECRET` y reiniciarse el backend.

Para disparar un evento simulado:

```bash
stripe trigger checkout.session.completed
```

Para una prueba completa es preferible crear una orden real en la base de datos, abrir Checkout desde el frontend y pagar en modo de prueba.

## 14. Configuración en producción

1. Publicar el backend mediante HTTPS.
2. Crear un endpoint en Stripe apuntando a:

```text
https://api.ejemplo.com/api/stripe/webhook
```

3. Suscribir como mínimo estos eventos:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
payment_intent.payment_failed
```

4. Guardar el secreto `whsec_...` de producción en el servidor.
5. Usar una clave `sk_live_...` únicamente cuando todo haya sido probado.
6. No registrar claves, datos de tarjeta ni el cuerpo completo de eventos en logs públicos.

## 15. Qué debe adaptarse en el otro proyecto

Solo deben cambiarse estas partes:

- La consulta `buscarOrden()` y el nombre de la tabla.
- La forma de calcular el total final.
- La autenticación `req.user.id`.
- Las URLs de éxito y cancelación.
- La lógica ejecutada después de confirmar el pago.
- La moneda, si no será MXN.

No deben cambiarse estos principios:

- El precio se obtiene del backend/base de datos.
- El webhook conserva el cuerpo raw.
- Se verifica la firma.
- Se valida importe y moneda.
- La confirmación usa una transacción y bloqueo de fila.
- El procesamiento es idempotente.
- Una orden pagada no vuelve a procesarse.
- React nunca confirma el pago por sí mismo.
- Las claves secretas nunca se colocan en el frontend.
