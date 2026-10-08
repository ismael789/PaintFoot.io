# PaintFoot.io

Aplicación móvil de conquista de territorios construida con Expo SDK 57 y React Native.

## Preparar el proyecto después de clonarlo

Requisitos: Node.js, npm y Expo Go o un dispositivo/emulador Android.

```powershell
git clone https://github.com/ismael789/PaintFoot.io.git
cd PaintFoot.io
npm install
Copy-Item .env.example .env
```

El archivo de configuración local debe llamarse exactamente `.env` y debe estar en la raíz del proyecto, al lado de `package.json`. `.env.example` contiene todas las variables admitidas y explica para qué sirve cada una.

Antes de iniciar, editar `.env` y reemplazar como mínimo:

- `EXPO_PUBLIC_WS_URL`: IP local de la computadora y puerto inicial `8082`.
- `EXPO_PUBLIC_STRIPE_API_URL`: la misma IP local y puerto inicial `4000`.
- `STRIPE_SECRET_KEY`: clave secreta de prueba entregada de forma privada por el responsable de la cuenta Stripe.
- `STRIPE_PUBLIC_KEY`: clave pública de prueba de la misma cuenta.
- Los `STRIPE_SHIELD_*_PRICE_ID` si se usan productos permanentes de Stripe. Si están vacíos, los escudos usan los importes `STRIPE_SHIELD_*_AMOUNT_CENTS` o `STRIPE_DEFAULT_AMOUNT_CENTS` mediante Checkout.
- `STRIPE_WEBHOOK_SECRET` cuando se prueben webhooks con Stripe CLI.

Ejemplo de direcciones para una computadora cuya IP es `192.168.1.50`:

```dotenv
EXPO_PUBLIC_WS_URL=ws://192.168.1.50:8082
EXPO_PUBLIC_STRIPE_API_URL=http://192.168.1.50:4000/api/stripe
```

El teléfono y la computadora deben estar conectados a la misma red local. La clave `STRIPE_SECRET_KEY` pertenece únicamente al servidor; nunca debe llevar el prefijo `EXPO_PUBLIC_` ni incluirse directamente en la aplicación móvil.

## Activar respaldo con Supabase

1. Abrir el SQL Editor del proyecto Supabase.
2. Ejecutar completo [`supabase/paintfoot-sync.sql`](supabase/paintfoot-sync.sql).
3. Ejecutar despues [`supabase/paintfoot-global-multiplayer.sql`](supabase/paintfoot-global-multiplayer.sql).
4. Confirmar que Email este habilitado en Authentication > Providers.
5. Configurar `EXPO_PUBLIC_SUPABASE_URL` y `EXPO_PUBLIC_SUPABASE_ANON_KEY`.

El script es no destructivo, activa RLS y crea la funcion idempotente de
sincronizacion. El segundo activa el mundo global, los colores estables,
presencia regional, historial de propietarios, disputas y la captura segura por
RPC. La aplicacion nunca necesita una clave `service_role`.

## Cuentas propias de PaintFoot

El login y registro de la aplicación usan la API privada de PaintFoot, no
Supabase Auth. Ejecuta [`supabase/paintfoot-custom-auth.sql`](supabase/paintfoot-custom-auth.sql)
en el SQL Editor y configura `SUPABASE_SECRET_KEY` solamente en `.env.local` o
`.env` del servidor. La clave no debe comenzar con `EXPO_PUBLIC_`, porque nunca
debe llegar a Expo Go ni al APK. Las contraseñas se guardan como hashes
derivados con `scrypt`; no se almacenan en texto plano y no se verifica el
correo electrónico antes de entrar.

## Ejecutar

Aplicación Expo:

```powershell
npm start
```

Este comando inicia Expo con selección automática de puerto. Si `8081` está
ocupado, Metro utiliza el siguiente puerto libre. WebSocket parte de `8082` y
Stripe de `4000`; ambos prueban puertos consecutivos y la app móvil encuentra
automáticamente el servidor correcto. Si se ejecuta Expo directamente, usar
`npx expo start --port 0` para obtener el mismo comportamiento automático.

Servidor local de compatibilidad y notificaciones, si no se inició automáticamente:

```powershell
npm run ws-server
```

Este servidor local no crea grupos ni mundos separados. El multijugador
principal utiliza un único mundo persistente en Supabase y canales geográficos
`paintfoot-world:<regionId>`; todos los jugadores autenticados consultan los
mismos territorios globales cercanos.

Servidor de pagos:

```powershell
npm run stripe-server
```

## Android APK

```powershell
npm run build:apk
```

El GPS en segundo plano, las notificaciones push remotas y algunas integraciones nativas requieren un development build o APK; Expo Go no ofrece todas esas capacidades.

## Verificación

```powershell
npx tsc --noEmit
npm run test:territory
```

## Archivos locales que no se publican

- `.env`: contiene credenciales y direcciones propias de cada equipo.
- `node_modules/`: se reconstruye exactamente con `npm install` y `package-lock.json`.
- `.expo/`: datos temporales generados por Expo.
- Carpetas de caché, compilación y almacenamiento local del servidor.

El proyecto, sus recursos, `package-lock.json` y la plantilla completa `.env.example` sí están versionados. Compartir la clave secreta por un canal privado evita que terceros ajenos al equipo puedan usar la cuenta de Stripe.
