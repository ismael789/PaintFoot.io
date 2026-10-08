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
      const offlineState = { route: [], territories: [], user: null, others: {}, userColor: '#208AEF' };

      const offlineCoordinates = () => {
        const territoryPoints = offlineState.territories.flatMap(item =>
          (item.polygon?.coordinates?.[0] || []).map(point => ({ latitude: point[1], longitude: point[0] }))
        );
        return [
          ...offlineState.route,
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
          const ring = (item.polygon?.coordinates?.[0] || []).map(point => project({ latitude: point[1], longitude: point[0] }));
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
      };

      const putTerritory = (id, latLngs, color, owner, areaM2, status) => {
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
      window.addTerritory = (id, coordinates, color, owner, areaM2) => {
        putTerritory(id, coordinates.map(point => [point.latitude, point.longitude]), color, owner, areaM2, 'confirmed');
      };
      window.setTerritories = (items) => {
        Object.keys(territoryLayers).forEach(removeTerritory);
        items.forEach(item => {
          const ring = item.polygon?.coordinates?.[0] || [];
          putTerritory(
            item.id,
            ring.map(point => [point[1], point[0]]),
            item.playerColor || item.color,
            item.owner,
            item.areaM2,
            item.status || 'confirmed'
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
