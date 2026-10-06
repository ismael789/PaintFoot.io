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

- `EXPO_PUBLIC_WS_URL`: IP local de la computadora y puerto `8082`.
- `EXPO_PUBLIC_STRIPE_API_URL`: la misma IP local y puerto `4000`.
- `STRIPE_SECRET_KEY`: clave secreta de prueba entregada de forma privada por el responsable de la cuenta Stripe.
- `STRIPE_PUBLIC_KEY`: clave pública de prueba de la misma cuenta.
- Los `STRIPE_SHIELD_*_PRICE_ID` si se usan productos permanentes de Stripe.
- `STRIPE_WEBHOOK_SECRET` cuando se prueben webhooks con Stripe CLI.

Ejemplo de direcciones para una computadora cuya IP es `192.168.1.50`:

```dotenv
EXPO_PUBLIC_WS_URL=ws://192.168.1.50:8082
EXPO_PUBLIC_STRIPE_API_URL=http://192.168.1.50:4000/api/stripe
```

El teléfono y la computadora deben estar conectados a la misma red local. La clave `STRIPE_SECRET_KEY` pertenece únicamente al servidor; nunca debe llevar el prefijo `EXPO_PUBLIC_` ni incluirse directamente en la aplicación móvil.

## Ejecutar

Aplicación Expo:

```powershell
npx expo start
```

Servidor multijugador/WebSocket, si no se inició automáticamente:

```powershell
npm run ws-server
```

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
