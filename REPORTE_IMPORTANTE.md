# Reporte importante — PaintFoot.io

## Propósito

PaintFoot.io es una aplicación móvil hecha con Expo y React Native. Puede probarse en Expo Go y compilarse como APK; el GPS en segundo plano solo se activa en el APK. Registra el desplazamiento físico, ajusta el recorrido a la red vial de OpenStreetMap y conquista únicamente circuitos válidos cerrados sobre calles.

Flujo objetivo:

Inicio → permiso de ubicación → iniciar recorrido → GPS crudo → Map Matching vial → cerrar circuito → validar y calcular área → guardar y colorear territorio.

## Entorno actual

| Elemento | Estado |
| --- | --- |
| Framework | Expo SDK ~57.0.26 |
| Interfaz | React Native + Expo Router |
| Pruebas | Expo Go en primer plano y APK para segundo plano |
| GPS | expo-location ~57.0.20 + expo-task-manager ~57.0.21 |
| Mapa | MapLibre GL JS dentro de react-native-webview |
| Estilo del mapa | OpenFreeMap, sin API key |
| Map Matching | Valhalla `trace_attributes`, perfil peatonal |
| Persistencia | AsyncStorage para GPS, perfil y territorios |
| Archivo principal | src/app/index.tsx |

## Funcionamiento actual

1. La app solicita permiso de ubicación en primer plano.
2. Obtiene una coordenada inicial y centra el mapa.
3. Al presionar Iniciar recorrido, agrega la posición actual como primer punto.
4. Inicia el seguimiento GPS de alta precisión y, en el APK, el servicio GPS en segundo plano.
5. Los puntos GPS aceptados se conservan como `rawTrack` y se envían por lotes al Map Matching peatonal.
6. Valhalla devuelve la geometría real de calles, sus segmentos y nodos; esa geometría forma el `snappedTrack` visible.
7. La detección comprueba cierres y autocruces únicamente sobre `snappedTrack`, nunca sobre el GPS crudo.
8. Cada circuito debe superar mínimos de área, perímetro, puntos y validez geométrica.
9. El territorio aparece inmediatamente con el color del perfil, muestra su área y se guarda en AsyncStorage.
10. Los territorios guardados se restauran y vuelven a dibujarse al abrir la aplicación.

## GPS y precisión

| Ajuste | Valor | Motivo |
| --- | --- | --- |
| Precisión | BestForNavigation | Máxima precisión disponible. |
| Entrega durante recorrido | 1 metro | Solicita actualizaciones detalladas. |
| Intervalo Android | 500 ms | Actualización visual rápida. |
| Filtro de precisión | 20 m | Ignora lecturas muy imprecisas. |
| Filtro de duplicados | 3 m | Reduce ruido GPS cuando el jugador está quieto. |
| Filtro de velocidad | 10 m/s | Descarta saltos irreales superiores a 36 km/h. |
| Multijugador pasivo | High, 5 m, 1 s | Comparte posición con menor consumo fuera de un recorrido. |

La prueba debe hacerse caminando en exterior. En interiores, bajo techo o con señal débil, las coordenadas pueden ser imprecisas.

## Estados y controles

- GPS ±N m muestra la incertidumbre GPS.
- GPS esperando señal aparece antes de recibir una ubicación.
- Precisión baja aparece cuando la incertidumbre supera 20 m.
- Existe un botón para reintentar permiso y GPS.
- La app avisa si el mapa reporta un problema de carga.
- El panel inferior indica recorrido activo/detenido, número de puntos y territorios capturados.

## Territorios

La detección utiliza geometría vial ajustada. Reconoce cierres en intersecciones, reencuentros con segmentos anteriores dentro de una tolerancia y múltiples circuitos creados por autocruces. Rechaza polígonos abiertos, corruptos, duplicados, demasiado pequeños o con recorrido insuficiente.

Los límites configurables se encuentran en `src/config/territory.ts`. Cada territorio conserva `playerId`, `playerColor`, GeoJSON Polygon, `areaM2`, fecha, firma geométrica y campos compatibles con el render anterior.

## Dependencias relevantes

| Dependencia | Uso |
| --- | --- |
| expo-location | Permisos, posición actual y seguimiento GPS. |
| expo-task-manager | Ejecuta la tarea GPS en segundo plano en el APK. |
| expo-notifications | Registra el ExpoPushToken y recibe notificaciones push remotas en el APK. |
| expo-intent-launcher | Abre los ajustes nativos de GPS y notificaciones mediante intents Android. |
| expo-device y expo-application | Validan el dispositivo e identifican la app al abrir ajustes Android. |
| AsyncStorage | Guarda puntos GPS, perfil local y territorios. |
| react-native-webview | Ejecuta MapLibre GL JS en Expo Go. |
| react-native-maps | Está en el proyecto, pero la pantalla actual usa WebView y MapLibre. |

OpenFreeMap no exige API key, pero el teléfono necesita Internet para descargar el mapa y sus teselas. El Map Matching usa por defecto el servidor público de demostración de Valhalla y procesa puntos por lotes; para producción debe configurarse una instancia propia mediante `EXPO_PUBLIC_MAP_MATCHING_URL`.

## Push remotas e intents Android

- El APK solicita permiso de notificaciones y obtiene un ExpoPushToken real.
- El token se registra en el servidor WebSocket. Cuando otro jugador cierra un territorio, el servidor envía una notificación remota mediante Expo Push Service.
- Al tocar la notificación, la app procesa sus datos y abre la pantalla del mapa.
- Los botones de ajustes usan intents Android reales para abrir GPS y notificaciones de PaintFoot.io.
- Expo Go para Android no admite notificaciones push remotas desde SDK 53. Los intents sí funcionan en Expo Go; las push deben probarse con el APK.
- Para un APK conectado al servidor local, copiar `.env.example` como `.env` y reemplazar la IP de ejemplo por la IP LAN de la computadora antes de compilar.

## Funciones aún no implementadas

- Login o identidad real.
- Usuarios múltiples.
- Base de datos o backend remoto.
- Sincronización completa de rutas y territorios entre dispositivos.
- Sincronizar y persistir territorios de todos los jugadores en un backend autoritativo.
- Ranking.
- Reglas completas de conquista.

## Jugadores cercanos

La app comparte la posición del jugador con otros teléfonos mediante el servidor WebSocket local. Si el servidor no está disponible, conserva el recorrido localmente y continúa en modo individual.

Para hacerlo sin Internet público:

Teléfonos y computadora en la misma Wi-Fi → servidor WebSocket local en la computadora → cada teléfono comparte su GPS → el mapa dibuja marcadores de jugadores cercanos.

La dirección exp://192.168.x.x:8081 de Expo sirve para cargar el código en Expo Go. No sincroniza jugadores. Visual Studio Code es el editor y tampoco comparte ubicaciones.

## Próximas fases sugeridas

1. Probar recorridos reales al aire libre y ajustar los filtros GPS.
2. Ajustar con recorridos reales los límites de cierre, área mínima y radio de búsqueda vial.
3. Desplegar una instancia propia de Valhalla antes de publicar para no depender del servidor de demostración.
4. Robustecer la reconexión y sincronización del servidor WebSocket local.
5. Añadir un backend autoritativo para validar conquistas multijugador.

## Comando de desarrollo

Ejecutar: npx expo start -c

Abrir Expo Go, escanear el QR y aceptar ubicación precisa.

Para solicitar un APK interno: npm run build:apk

Pruebas geométricas y del adaptador vial: npm run test:territory

