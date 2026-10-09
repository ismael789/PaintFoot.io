// Leaflet uses DOM/SVG instead of WebGL, so it remains compatible with older
// Android System WebView versions used by some Expo Go devices.
export const MAP_HTML = `<!doctype html>
<html><head>
  <meta name="viewport" content="initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" rel="stylesheet" />
  <style>
    html, body, #map { margin: 0; width: 100%; height: 100%; background: #e8edf2; }
    .territory-label { background: rgba(255,255,255,.88); border: 0; border-radius: 5px; box-shadow: none; color: #1A1A2E; font: 700 12px sans-serif; text-align: center; }
    .territory-label:before { display: none; }
    #map-failure { align-items: center; box-sizing: border-box; color: #4B5875; display: none; font: 600 14px sans-serif; height: 100%; justify-content: center; padding: 24px; text-align: center; }
    .offline-map { background-color: #e8edf2; background-image: linear-gradient(#cbd5df 1px, transparent 1px), linear-gradient(90deg, #cbd5df 1px, transparent 1px); background-size: 32px 32px; height: 100%; overflow: hidden; position: relative; width: 100%; }
    .offline-map svg { height: 100%; width: 100%; }
    .offline-note { background: rgba(26,26,46,.88); border-radius: 12px; color: white; font: 700 12px sans-serif; left: 50%; padding: 8px 12px; position: absolute; top: 12px; transform: translateX(-50%); white-space: nowrap; z-index: 2; }
    .coin-marker { align-items: center; background: #FFD54A; border: 3px solid #FFF3A6; border-radius: 50%; box-shadow: 0 2px 7px rgba(78, 55, 0, .45); color: #7A5200; display: flex; font: 900 16px sans-serif; height: 30px; justify-content: center; width: 30px; }
    .coin-marker span { line-height: 1; }
    .coin-marker { animation: coinFloat 1.35s ease-in-out infinite; z-index: 900; }
    .shield-marker { align-items: center; animation: shieldPending 1.8s ease-in-out infinite; background: rgba(255,255,255,.94); border: 2px dashed #8D99AE; border-radius: 50%; box-shadow: 0 2px 8px rgba(25,35,55,.28); color: #596579; display: flex; font: 900 15px sans-serif; height: 30px; justify-content: center; width: 30px; }
    .shield-marker.active { animation: shieldPulse 1.5s ease-in-out infinite; border: 2px solid #66E3A4; color: #087443; }
    .shield-marker span { line-height: 1; }
    .shield-active { animation: shieldSvgPulse 1.5s ease-in-out infinite; fill: #087443; }
    .shield-pending { animation: shieldSvgPending 1.8s ease-in-out infinite; fill: #596579; }
    @keyframes shieldPending { 0%,100% { opacity: .52; } 50% { opacity: 1; } }
    @keyframes shieldPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(102,227,164,.55), 0 2px 8px rgba(25,35,55,.28); } 50% { box-shadow: 0 0 0 9px rgba(102,227,164,0), 0 2px 10px rgba(25,35,55,.35); } }
    @keyframes shieldSvgPulse { 0%,100% { opacity: .72; transform: scale(.9); transform-origin: center; } 50% { opacity: 1; transform: scale(1.12); transform-origin: center; } }
    @keyframes shieldSvgPending { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
    @keyframes coinFloat { 0%,100% { margin-top: 0; } 50% { margin-top: -5px; } }
  </style>
</head><body><div id="map"></div>
  <div id="map-failure">No se pudo iniciar el mapa. Comprueba la conexion a Internet.</div>
  <script>
    const sendToApp = (type, detail) => {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type, detail }));
    };
    const showMapFailure = (detail) => {
      document.getElementById('map').style.display = 'none';
      document.getElementById('map-failure').style.display = 'flex';
      sendToApp('map-error', detail || 'leaflet-load-error');
    };
    window.addEventListener('error', (event) => {
      sendToApp('map-error', event.message || 'webview-script-error');
    });
  </script>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" onerror="sendToApp('map-offline', 'leaflet-download-error')"></script>
  <script>
    if (!window.L) {
      const mapElement = document.getElementById('map');
      mapElement.className = 'offline-map';
      mapElement.innerHTML = '<div class="offline-note">Sin mapa base · el recorrido GPS se guarda</div><svg viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet"></svg>';
      const offlineSvg = mapElement.querySelector('svg');
      const svgNamespace = 'http://www.w3.org/2000/svg';
      const offlineState = { route: [], territories: [], coins: [], user: null, others: {}, userColor: '#208AEF' };

      const offlineCoordinates = () => {
        const territoryPoints = offlineState.territories.flatMap(item =>
          (item.polygon?.coordinates?.[0] || []).map(point => ({ latitude: point[1], longitude: point[0] }))
        );
        return [
          ...offlineState.route,
          ...offlineState.coins,
          ...territoryPoints,
          ...(offlineState.user ? [offlineState.user] : []),
          ...Object.values(offlineState.others),
          ...Object.values(offlineState.others).flatMap(player => player.trail || [])
        ];
      };
      const drawOfflineMap = () => {
        const coordinates = offlineCoordinates();
        while (offlineSvg.firstChild) offlineSvg.removeChild(offlineSvg.firstChild);
        if (!coordinates.length) return;
        const latitudes = coordinates.map(point => point.latitude);
        const longitudes = coordinates.map(point => point.longitude);
        const minLatitude = Math.min(...latitudes);
        const maxLatitude = Math.max(...latitudes);
        const minLongitude = Math.min(...longitudes);
        const maxLongitude = Math.max(...longitudes);
        const latitudeSpan = Math.max(0.0001, maxLatitude - minLatitude);
        const longitudeSpan = Math.max(0.0001, maxLongitude - minLongitude);
        const project = point => ({
          x: 70 + ((point.longitude - minLongitude) / longitudeSpan) * 860,
          y: 930 - ((point.latitude - minLatitude) / latitudeSpan) * 860
        });

        offlineState.territories.forEach(item => {
          const sourceRing = item.polygon?.coordinates?.[0] || [];
          const ringCoordinates = sourceRing.length > 0 &&
            (sourceRing[0][0] !== sourceRing[sourceRing.length - 1][0] ||
              sourceRing[0][1] !== sourceRing[sourceRing.length - 1][1])
            ? [...sourceRing, sourceRing[0]]
            : sourceRing;
          const ring = ringCoordinates.map(point => project({ latitude: point[1], longitude: point[0] }));
          if (ring.length < 3) return;
          const polygon = document.createElementNS(svgNamespace, 'polygon');
          polygon.setAttribute('points', ring.map(point => point.x + ',' + point.y).join(' '));
          polygon.setAttribute('fill', item.playerColor || item.color || '#208AEF');
          const pending = item.status === 'pending_capture' || item.status === 'pending_validation';
          polygon.setAttribute('fill-opacity', pending ? '0' : '0.28');
          if (pending) polygon.setAttribute('stroke-dasharray', '12 10');
          polygon.setAttribute('stroke', item.playerColor || item.color || '#208AEF');
          polygon.setAttribute('stroke-width', '7');
          offlineSvg.appendChild(polygon);
          const center = ring.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
          center.x /= ring.length;
          center.y /= ring.length;
          const shield = document.createElementNS(svgNamespace, 'text');
          const shieldActive = Number(item.shield?.expiresAt || 0) > Date.now();
          shield.setAttribute('x', String(center.x));
          shield.setAttribute('y', String(center.y + 7));
          shield.setAttribute('text-anchor', 'middle');
          shield.setAttribute('font-size', '22');
          shield.setAttribute('class', shieldActive ? 'shield-active' : 'shield-pending');
          shield.textContent = shieldActive ? '🛡' : '◌';
          offlineSvg.appendChild(shield);
        });

        if (offlineState.route.length > 1) {
          const route = document.createElementNS(svgNamespace, 'polyline');
          route.setAttribute('points', offlineState.route.map(project).map(point => point.x + ',' + point.y).join(' '));
          route.setAttribute('fill', 'none');
          route.setAttribute('stroke', offlineState.userColor);
          route.setAttribute('stroke-linecap', 'round');
          route.setAttribute('stroke-linejoin', 'round');
          route.setAttribute('stroke-width', '11');
          offlineSvg.appendChild(route);
        }

        Object.values(offlineState.others).forEach(player => {
          if (!Array.isArray(player.trail) || player.trail.length < 2) return;
          const trail = document.createElementNS(svgNamespace, 'polyline');
          trail.setAttribute('points', player.trail.map(project).map(point => point.x + ',' + point.y).join(' '));
          trail.setAttribute('fill', 'none');
          trail.setAttribute('stroke', player.color || '#FF8800');
          trail.setAttribute('stroke-opacity', '0.72');
          trail.setAttribute('stroke-width', '7');
          trail.setAttribute('stroke-linecap', 'round');
          offlineSvg.appendChild(trail);
        });

        const drawPlayer = (point, color, radius) => {
          const projected = project(point);
          const marker = document.createElementNS(svgNamespace, 'circle');
          marker.setAttribute('cx', String(projected.x));
          marker.setAttribute('cy', String(projected.y));
          marker.setAttribute('r', String(radius));
          marker.setAttribute('fill', color);
          marker.setAttribute('stroke', '#FFFFFF');
          marker.setAttribute('stroke-width', '7');
          offlineSvg.appendChild(marker);
        };
        Object.values(offlineState.others).forEach(point => drawPlayer(point, point.color || '#FF8800', 13));
        if (offlineState.user) drawPlayer(offlineState.user, offlineState.userColor, 16);
        offlineState.coins.forEach(coin => {
          const projected = project(coin);
          const marker = document.createElementNS(svgNamespace, 'g');
          const circle = document.createElementNS(svgNamespace, 'circle');
          circle.setAttribute('cx', String(projected.x));
          circle.setAttribute('cy', String(projected.y));
          circle.setAttribute('r', '16');
          circle.setAttribute('fill', '#FFD54A');
          circle.setAttribute('stroke', '#FFF3A6');
          circle.setAttribute('stroke-width', '5');
          const text = document.createElementNS(svgNamespace, 'text');
          text.setAttribute('x', String(projected.x));
          text.setAttribute('y', String(projected.y + 7));
          text.setAttribute('fill', '#7A5200');
          text.setAttribute('font-size', '17');
          text.setAttribute('font-weight', '900');
          text.setAttribute('text-anchor', 'middle');
          text.textContent = '🪙';
          marker.appendChild(circle);
          marker.appendChild(text);
          offlineSvg.appendChild(marker);
        });
      };

      window.setUserLocation = (latitude, longitude) => {
        offlineState.user = { latitude, longitude };
        drawOfflineMap();
      };
      window.setPlayerColor = color => {
        offlineState.userColor = color || '#208AEF';
        drawOfflineMap();
      };
      window.setOtherPlayerLocation = (id, latitude, longitude, color) => {
        offlineState.others[id] = { latitude, longitude, color };
        drawOfflineMap();
      };
      window.setOtherPlayers = players => {
        offlineState.others = {};
        (players || []).forEach(player => {
          offlineState.others[player.id] = player;
        });
        drawOfflineMap();
      };
      window.addRoutePoint = (latitude, longitude) => {
        offlineState.route.push({ latitude, longitude });
        window.setUserLocation(latitude, longitude);
      };
      window.setRoute = coordinates => {
        offlineState.route = Array.isArray(coordinates) ? coordinates : [];
        drawOfflineMap();
      };
      window.clearRoute = () => {
        offlineState.route = [];
        drawOfflineMap();
      };
      window.setCoins = coins => {
        offlineState.coins = Array.isArray(coins) ? coins : [];
        drawOfflineMap();
      };
      window.addTerritory = (id, coordinates, color, owner, areaM2) => {
        offlineState.territories.push({
          id, color, owner, areaM2,
          polygon: { coordinates: [coordinates.map(point => [point.longitude, point.latitude])] }
        });
        drawOfflineMap();
      };
      window.setTerritories = items => {
        offlineState.territories = Array.isArray(items) ? items : [];
        drawOfflineMap();
      };
      window.mapReady = true;
      sendToApp('map-ready', 'offline-fallback');
    } else {
      const map = L.map('map', { zoomControl: true }).setView([19.4326, -99.1332], 13);
      const tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
      }).addTo(map);
      let tileErrorCount = 0;
      tileLayer.on('tileload', () => { tileErrorCount = 0; });
      tileLayer.on('tileerror', () => {
        tileErrorCount += 1;
        if (tileErrorCount === 6) sendToApp('map-error', 'openstreetmap-tile-error');
      });

      let userColor = '#208AEF';
      let userMarker = null;
      const otherMarkers = {};
      const otherTrails = {};
      const routeLayer = L.polyline([], { color: userColor, weight: 5 }).addTo(map);
      const territoryLayers = {};
      const shieldLayers = {};
      const coinLayers = {};
      const coinIcon = L.divIcon({
        className: 'coin-marker',
        html: '<span>🪙</span>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });

      const playerMarkerOptions = (color) => ({
        color: '#FFFFFF',
        fillColor: color,
        fillOpacity: 1,
        radius: 9,
        weight: 3
      });

      const removeTerritory = (id) => {
        const layer = territoryLayers[id];
        if (!layer) return;
        map.removeLayer(layer);
        delete territoryLayers[id];
        const shieldLayer = shieldLayers[id];
        if (shieldLayer) {
          map.removeLayer(shieldLayer);
          delete shieldLayers[id];
        }
      };

      const putTerritory = (id, latLngs, color, owner, areaM2, status, shield) => {
        removeTerritory(id);
        const pending = status === 'pending_capture' || status === 'pending_validation';
        const disputed = status === 'disputed';
        const label = (owner || '') + '<br>' + Math.round(areaM2 || 0).toLocaleString() + ' m²';
        territoryLayers[id] = L.polygon(latLngs, {
          color: color || '#208AEF',
          fillColor: color || '#208AEF',
          fillOpacity: pending ? 0 : (disputed ? 0.14 : 0.30),
          opacity: 0.95,
          weight: 4,
          lineCap: 'round',
          lineJoin: 'round',
          dashArray: pending ? '8 8' : (disputed ? '12 6 3 6' : null)
        }).bindTooltip(label, {
          permanent: true,
          direction: 'center',
          className: 'territory-label'
        }).addTo(map);
        if (latLngs.length >= 3) {
          const bounds = L.latLngBounds(latLngs);
          const shieldActive = Number(shield?.expiresAt || 0) > Date.now();
          const shieldIcon = L.divIcon({
            className: 'shield-marker' + (shieldActive ? ' active' : ''),
            html: '<span>' + (shieldActive ? '🛡' : '◌') + '</span>',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          });
          shieldLayers[id] = L.marker(bounds.getCenter(), {
            icon: shieldIcon,
            keyboard: false,
            zIndexOffset: 400
          }).bindTooltip(
            shieldActive
              ? 'Escudo activo · visible para todos'
              : 'Escudo aún no activo',
            { direction: 'top' }
          ).addTo(map);
        }
      };

      window.setUserLocation = (latitude, longitude, center) => {
        const coordinate = [latitude, longitude];
        if (!userMarker) {
          userMarker = L.circleMarker(coordinate, playerMarkerOptions(userColor)).addTo(map);
        } else {
          userMarker.setLatLng(coordinate);
        }
        if (center) map.flyTo(coordinate, Math.max(map.getZoom(), 16), { animate: true });
      };
      window.setPlayerColor = (color) => {
        userColor = color || '#208AEF';
        if (userMarker) userMarker.setStyle(playerMarkerOptions(userColor));
        routeLayer.setStyle({ color: userColor });
      };
      window.setOtherPlayerLocation = (id, latitude, longitude, color) => {
        const coordinate = [latitude, longitude];
        if (!otherMarkers[id]) {
          otherMarkers[id] = L.circleMarker(coordinate, playerMarkerOptions(color || '#FF8800')).addTo(map);
        } else {
          otherMarkers[id].setLatLng(coordinate);
          otherMarkers[id].setStyle(playerMarkerOptions(color || '#FF8800'));
        }
      };
      window.setOtherPlayers = (players) => {
        const incoming = new Set((players || []).map(player => player.id));
        Object.keys(otherMarkers).forEach(id => {
          if (!incoming.has(id)) {
            map.removeLayer(otherMarkers[id]);
            delete otherMarkers[id];
          }
        });
        Object.keys(otherTrails).forEach(id => {
          if (!incoming.has(id)) {
            map.removeLayer(otherTrails[id]);
            delete otherTrails[id];
          }
        });
        (players || []).forEach(player => {
          window.setOtherPlayerLocation(player.id, player.latitude, player.longitude, player.color);
          const trailCoordinates = Array.isArray(player.trail)
            ? player.trail.map(point => [point.latitude, point.longitude])
            : [];
          if (trailCoordinates.length > 1) {
            if (!otherTrails[player.id]) {
              otherTrails[player.id] = L.polyline(trailCoordinates, {
                color: player.color || '#FF8800', opacity: 0.72, weight: 3,
                lineCap: 'round', lineJoin: 'round'
              }).addTo(map);
            } else {
              otherTrails[player.id].setLatLngs(trailCoordinates);
              otherTrails[player.id].setStyle({ color: player.color || '#FF8800' });
            }
          } else if (otherTrails[player.id]) {
            map.removeLayer(otherTrails[player.id]);
            delete otherTrails[player.id];
          }
          if (player.name && otherMarkers[player.id]) {
            otherMarkers[player.id].bindTooltip(player.name, { direction: 'top', offset: [0, -8] });
          } else if (otherMarkers[player.id]) {
            otherMarkers[player.id].unbindTooltip();
          }
        });
      };
      window.addRoutePoint = (latitude, longitude) => {
        window.setUserLocation(latitude, longitude, true);
        routeLayer.addLatLng([latitude, longitude]);
      };
      window.setRoute = (coordinates) => {
        routeLayer.setLatLngs(coordinates.map(point => [point.latitude, point.longitude]));
      };
      window.clearRoute = () => {
        routeLayer.setLatLngs([]);
      };
      window.setCoins = (coins) => {
        Object.keys(coinLayers).forEach(id => {
          map.removeLayer(coinLayers[id]);
          delete coinLayers[id];
        });
        (coins || []).forEach(coin => {
          coinLayers[coin.id] = L.marker([coin.latitude, coin.longitude], {
            icon: coinIcon,
            title: 'Moneda · +' + (coin.value || 1),
            keyboard: false,
            zIndexOffset: 1000
          }).bindTooltip('Moneda · +' + (coin.value || 1), { direction: 'top' }).addTo(map);
          coinLayers[coin.id].bringToFront();
        });
      };
      window.addTerritory = (id, coordinates, color, owner, areaM2) => {
        putTerritory(id, coordinates.map(point => [point.latitude, point.longitude]), color, owner, areaM2, 'confirmed', null);
      };
      window.setTerritories = (items) => {
        Object.keys(territoryLayers).forEach(removeTerritory);
        items.forEach(item => {
          const sourceRing = item.polygon?.coordinates?.[0] || [];
          const ring = sourceRing.length > 0 &&
            (sourceRing[0][0] !== sourceRing[sourceRing.length - 1][0] ||
              sourceRing[0][1] !== sourceRing[sourceRing.length - 1][1])
            ? [...sourceRing, sourceRing[0]]
            : sourceRing;
          putTerritory(
            item.id,
            ring.map(point => [point[1], point[0]]),
            item.playerColor || item.color,
            item.owner,
            item.areaM2,
            item.status || 'confirmed',
            item.shield || null
          );
        });
      };

      map.whenReady(() => {
        window.mapReady = true;
        sendToApp('map-ready');
      });
    }
  </script>
</body></html>`;
