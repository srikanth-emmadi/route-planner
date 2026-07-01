import React, { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import './App.css';

// ====== FIX BROKEN PINS ======
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});
// =============================

const APP_PASSWORD = "admin";

const haversine = (a, b) => {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const parseDMS = (str) => {
  if (!str) return NaN;
  str = str.trim().toUpperCase();
  const decMatch = str.match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/);
  if (decMatch) return parseFloat(decMatch[1]) * ((decMatch[2] === 'S' || decMatch[2] === 'W') ? -1 : 1);
  const dmsMatch = str.match(/(\d+)[^0-9]+(\d+)[^0-9]+([\d\.]+)[^A-Z]*([NSEW])/i);
  if (dmsMatch) return (parseFloat(dmsMatch[1]) + (parseFloat(dmsMatch[2]) / 60) + (parseFloat(dmsMatch[3]) / 3600)) * ((dmsMatch[4] === 'S' || dmsMatch[4] === 'W') ? -1 : 1);
  const fb = str.match(/(-?\d+)[^0-9]+(\d+)[^0-9]+([\d\.]+)/);
  if (fb) return (parseFloat(fb[1]) < 0 ? -1 : 1) * (Math.abs(parseFloat(fb[1])) + (parseFloat(fb[2]) / 60) + (parseFloat(fb[3]) / 3600));
  return parseFloat(str);
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const [status, setStatus] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [latQuery, setLatQuery] = useState("");
  const [lonQuery, setLonQuery] = useState("");
  
  const [stops, setStops] = useState([]); 
  const [legsUI, setLegsUI] = useState([]);
  const [totalText, setTotalText] = useState("");

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const distLabelsLayerRef = useRef(null);
  const routeLineRef = useRef(null);
  const stopsDataRef = useRef([]); 
  const debounceTimer = useRef(null);

  useEffect(() => {
    if (isAuthenticated && mapContainerRef.current && !mapRef.current) {
      mapRef.current = L.map(mapContainerRef.current, { preferCanvas: true, zoomControl: false }).setView([17.385, 78.486], 6);
      L.control.zoom({ position: 'topright' }).addTo(mapRef.current);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(mapRef.current);
      distLabelsLayerRef.current = L.layerGroup().addTo(mapRef.current);
    }
  }, [isAuthenticated]);

  const handleLogin = () => {
    if (password === APP_PASSWORD) setIsAuthenticated(true);
    else setLoginError(true);
  };

  const handleSearchInput = (e) => {
    const query = e.target.value;
    setSearchQuery(query);
    clearTimeout(debounceTimer.current);
    if (query.length < 3) return setSuggestions([]);
    
    debounceTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`);
        const data = await res.json();
        setSuggestions(data);
      } catch (err) { console.error(err); }
    }, 400);
  };

  const setupDraggableLabel = (lat, lon, htmlClass, content, lineColor) => {
    const pin = [lat, lon];
    const leaderLine = L.polyline([pin, pin], { color: lineColor, weight: 2, dashArray: '4,4' }).addTo(mapRef.current);
    const labelMarker = L.marker(pin, {
      icon: L.divIcon({ className: 'custom-label-container', html: `<div class="${htmlClass}">${content}</div>`, iconSize: null, iconAnchor: [0, 15] }),
      draggable: true
    }).addTo(mapRef.current);
    labelMarker.on('drag', (e) => leaderLine.setLatLngs([pin, e.target.getLatLng()]));
    return { labelMarker, leaderLine };
  };

  const addDirectPlace = async (name, lat, lon) => {
    const marker = L.marker([lat, lon]).addTo(mapRef.current).bindPopup(name);
    const { labelMarker, leaderLine } = setupDraggableLabel(lat, lon, 'draggable-label', name, '#8b9bab');
    
    const newStop = { id: Date.now(), name, lat, lon, marker, labelMarker, leaderLine };
    stopsDataRef.current.push(newStop);
    updateStopsUI();
    
    mapRef.current.flyTo([lat, lon], 12, { duration: 1.5 });
    
    await computeRoute();
    setStatus('');
    if (window.innerWidth <= 768) setIsMobileOpen(false); 
  };

  const handleAddSearch = async () => {
    if (!searchQuery.trim()) return;
    setSuggestions([]);
    setStatus('Searching...');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`);
      const data = await res.json();
      if (!data.length) throw new Error('Not found');
      setSearchQuery('');
      await addDirectPlace(data[0].name || data[0].display_name.split(',')[0], parseFloat(data[0].lat), parseFloat(data[0].lon));
    } catch (e) { setStatus('Could not find: ' + searchQuery); }
  };

  const handleAddCoords = async () => {
    let lat = parseDMS(latQuery);
    let lon = parseDMS(lonQuery);

    if (!lonQuery && latQuery.length > 10) {
      const splitMatch = latQuery.match(/([NS])\s*(.*)/i);
      if (splitMatch) {
        lat = parseDMS(latQuery.substring(0, splitMatch.index + 1));
        lon = parseDMS(splitMatch[2]);
      }
    }
    if (isNaN(lat) || isNaN(lon)) return setStatus('Enter valid coords');
    
    setLatQuery(''); setLonQuery('');
    await addDirectPlace(`(${lat.toFixed(4)}, ${lon.toFixed(4)})`, lat, lon);
  };

  const updateStopsUI = () => setStops(stopsDataRef.current.map(s => ({ id: s.id, name: s.name })));

  // IMPROVED: Smoothly zoom map to fit all bounds vertically & horizontally
  const fitMap = () => {
    if (stopsDataRef.current.length === 0) return;
    const bounds = L.latLngBounds(stopsDataRef.current.map(s => [s.lat, s.lon]));
    // flyToBounds auto-calculates the exact zoom level needed to fit all points
    mapRef.current.flyToBounds(bounds, { padding: [50, 50], duration: 1.2 });
  };

  const zoomToLocation = (index) => {
    const stop = stopsDataRef.current[index];
    if (stop && mapRef.current) {
      mapRef.current.flyTo([stop.lat, stop.lon], 13, { duration: 1.5 });
      stop.marker.openPopup(); 
      if (window.innerWidth <= 768) setIsMobileOpen(false);
    }
  };

  const renameStop = async (index) => {
    const stop = stopsDataRef.current[index];
    const newName = prompt('Enter site name:', stop.name);
    if (!newName || !newName.trim()) return;
    
    stop.name = newName.trim();
    stop.marker.setPopupContent(stop.name);
    stop.labelMarker.setIcon(L.divIcon({
      className: 'custom-label-container', html: `<div class="draggable-label">${stop.name}</div>`, iconSize: null, iconAnchor: [0, 15]
    }));
    updateStopsUI();
    await computeRoute();
  };

  const removeStop = async (index) => {
    const stop = stopsDataRef.current[index];
    mapRef.current.removeLayer(stop.marker);
    mapRef.current.removeLayer(stop.labelMarker);
    mapRef.current.removeLayer(stop.leaderLine);
    stopsDataRef.current.splice(index, 1);
    updateStopsUI();
    await computeRoute();
  };

  const optimizeRoute = async () => {
    if (stopsDataRef.current.length < 3) return;
    const start = stopsDataRef.current[0];
    const rest = stopsDataRef.current.slice(1);
    const ordered = [start];
    while (rest.length) {
      const last = ordered[ordered.length - 1];
      let bestIdx = 0, bestDist = Infinity;
      rest.forEach((s, idx) => {
        const d = haversine(last, s);
        if (d < bestDist) { bestDist = d; bestIdx = idx; }
      });
      ordered.push(rest.splice(bestIdx, 1)[0]);
    }
    stopsDataRef.current = ordered;
    updateStopsUI();
    await computeRoute();
    
    fitMap(); // Auto-fit screen after optimizing
    if (window.innerWidth <= 768) setIsMobileOpen(false); 
  };

  const createDistDraggableLabel = (midLat, midLon, kmText) => {
    const mid = [midLat, midLon];
    const distLine = L.polyline([mid, mid], { color: '#ff7a45', weight: 1.5, dashArray: '4,4' }).addTo(distLabelsLayerRef.current);
    const distLabelMarker = L.marker(mid, {
      icon: L.divIcon({ className: 'custom-label-container', html: `<div class="dist-draggable-label">${kmText}</div>`, iconSize: null, iconAnchor: [0, 12] }),
      draggable: true
    }).addTo(distLabelsLayerRef.current);
    distLabelMarker.on('drag', (e) => distLine.setLatLngs([mid, e.target.getLatLng()]));
  };

  const computeRoute = async () => {
    if (routeLineRef.current) { mapRef.current.removeLayer(routeLineRef.current); routeLineRef.current = null; }
    distLabelsLayerRef.current.clearLayers();
    setLegsUI([]); setTotalText("");
    const currStops = stopsDataRef.current;
    if (currStops.length < 2) return;

    setStatus('Calculating...');
    const coords = currStops.map(s => `${s.lon},${s.lat}`).join(';');
    try {
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
      const data = await res.json();
      if (data.code !== 'Ok') throw new Error('routing failed');
      
      routeLineRef.current = L.geoJSON(data.routes[0].geometry, { style: { color: '#ff7a45', weight: 4 } }).addTo(mapRef.current);
      
      let totalKm = 0;
      const newLegs = [];
      data.routes[0].legs.forEach((leg, i) => {
        const km = (leg.distance / 1000).toFixed(1);
        const mins = Math.round(leg.duration / 60);
        totalKm += leg.distance / 1000;
        
        newLegs.push({ from: currStops[i].name, to: currStops[i+1].name, km, mins, type: 'routed' });
        createDistDraggableLabel((currStops[i].lat + currStops[i+1].lat)/2, (currStops[i].lon + currStops[i+1].lon)/2, `${km} km`);
      });
      setLegsUI(newLegs);
      setTotalText(`Total: ${totalKm.toFixed(1)} km, ~${Math.round(data.routes[0].duration / 60)} min`);
      setStatus('');
    } catch (e) {
      let totalKm = 0;
      const newLegs = [];
      for (let i = 0; i < currStops.length - 1; i++) {
        const d = haversine(currStops[i], currStops[i+1]);
        totalKm += d;
        newLegs.push({ from: currStops[i].name, to: currStops[i+1].name, km: d.toFixed(1), type: 'straight' });
        routeLineRef.current = L.polyline([[currStops[i].lat, currStops[i].lon], [currStops[i+1].lat, currStops[i+1].lon]], { color: '#ff7a45', weight: 3, dashArray: '6,6' }).addTo(mapRef.current);
        createDistDraggableLabel((currStops[i].lat + currStops[i+1].lat)/2, (currStops[i].lon + currStops[i+1].lon)/2, `${d.toFixed(1)} km`);
      }
      setLegsUI(newLegs);
      setTotalText(`Total (straight-line): ${totalKm.toFixed(1)} km`);
      setStatus('Live routing unavailable — showing straight-line distances.');
    }
  };

    const exportMap = async (type) => {
    setStatus('Exporting in High Quality...');
    if (window.innerWidth <= 768) setIsMobileOpen(false); 
    
    await new Promise(r => setTimeout(r, 800)); 
    
    // Temporarily hide the Fit Button for a clean screenshot
    const fitBtn = document.querySelector('.fit-map-btn');
    if(fitBtn) fitBtn.style.display = 'none';

    const canvas = await html2canvas(mapContainerRef.current, { 
        useCORS: true, allowTaint: true, scale: 3, logging: false
    });
    
    if(fitBtn) fitBtn.style.display = 'flex'; // Bring it back

    if (type === 'img') {
      const link = document.createElement('a');
      link.download = 'route-map-high-res.png'; 
      link.href = canvas.toDataURL('image/png'); 
      link.click();
    } else {
      // --- SMART PDF LAYOUT ---
      const isLandscape = canvas.width > canvas.height;
      const pdf = new jsPDF({ 
        orientation: isLandscape ? 'l' : 'p', 
        unit: 'pt', 
        format: 'a4' 
      });
      
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      
      const imgData = canvas.toDataURL('image/jpeg', 1.0);
      const imgProps = pdf.getImageProperties(imgData);

      let mapW, mapH, mapX, mapY, textStartX, textStartY;

      if (isLandscape) {
        // LANDSCAPE: Map Left (65%), Text Right (35%)
        const maxMapW = pw * 0.65;
        const maxMapH = ph - 40;
        
        mapW = maxMapW;
        mapH = (imgProps.height * mapW) / imgProps.width;
        
        if (mapH > maxMapH) {
          mapH = maxMapH;
          mapW = (imgProps.width * mapH) / imgProps.height;
        }
        
        mapX = 20;
        mapY = (ph - mapH) / 2; // Center vertically
        if (mapY < 20) mapY = 20;
        
        textStartX = mapX + mapW + 20;
        textStartY = Math.max(mapY, 40);
      } else {
        // PORTRAIT: Map Top Row, Text Bottom Row
        const maxMapW = pw - 40;
        const maxMapH = ph * 0.55; // Map takes top 55%
        
        mapW = maxMapW;
        mapH = (imgProps.height * mapW) / imgProps.width;
        
        if (mapH > maxMapH) {
          mapH = maxMapH;
          mapW = (imgProps.width * mapH) / imgProps.height;
        }
        
        mapX = (pw - mapW) / 2; // Center horizontally
        mapY = 20;
        
        textStartX = 40;
        textStartY = mapY + mapH + 30;
      }

      // Draw the Map
      pdf.addImage(imgData, 'JPEG', mapX, mapY, mapW, mapH, undefined, 'FAST');
      
      // Draw Text Headers
      pdf.setFontSize(14); 
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(30, 30, 30);
      pdf.text("Route Stops & Coordinates:", textStartX, textStartY); 
      
      let currentY = textStartY + 25;
      let currentX = textStartX;

      // Draw Stops
      stopsDataRef.current.forEach((s, i) => {
        // If text hits the bottom of the page, create a new page
        if (currentY > ph - 40) {
          pdf.addPage();
          currentY = 40;
          currentX = 40; // Reset text to left margin on a fresh page
        }
        
        // Stop Name (Bold)
        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(40, 40, 40);
        pdf.text(`${i+1}. ${s.name}`, currentX, currentY);
        
        // Coordinates (Normal, slightly gray, indented)
        pdf.setFontSize(10);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(100, 100, 100);
        pdf.text(`     ${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}`, currentX, currentY + 12);
        
        currentY += 28; // Space between stops
      });

      pdf.save('route-map-high-res.pdf');
    }
    setStatus('');
  };

  if (!isAuthenticated) {
    return (
      <div className="login-wrap">
        <div className="login-box">
          <h2>App Login</h2>
          <input type="password" placeholder="Enter Password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          <button onClick={handleLogin}>Login</button>
          {loginError && <div className="error-text">Incorrect password.</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <button className="mobile-open-btn" onClick={() => setIsMobileOpen(true)}>
        ☰ Open Planner
      </button>

      <div className={`mobile-overlay ${isMobileOpen ? 'open' : ''}`} onClick={() => setIsMobileOpen(false)}></div>

      <div id="sidebar" className={isMobileOpen ? 'open' : ''} onClick={() => setSuggestions([])}>
        <div className="sidebar-header">
          <h1>Route Planner</h1>
          <button className="mobile-close-btn" onClick={() => setIsMobileOpen(false)}>✕</button>
        </div>

        <div className="add-row">
          <div className="autocomplete-wrapper">
            <input type="text" placeholder="Place name or address" value={searchQuery} onChange={handleSearchInput} onKeyDown={e => e.key === 'Enter' && handleAddSearch()} />
            {suggestions.length > 0 && (
              <ul id="suggestions" style={{ display: 'block' }}>
                {suggestions.map((item, i) => (
                  <li key={i} onClick={() => { setSearchQuery(''); setSuggestions([]); addDirectPlace(item.name || item.display_name.split(',')[0], parseFloat(item.lat), parseFloat(item.lon)); }}>
                    <span className="sugg-title">{item.name || item.display_name.split(',')[0]}</span>
                    <span className="sugg-desc">{item.display_name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button onClick={handleAddSearch}>Add</button>
        </div>
        
        <div className="add-col">
          <input type="text" placeholder="Latitude (e.g. 13°55'23.5&quot;N)" value={latQuery} onChange={e => setLatQuery(e.target.value)} />
          <input type="text" placeholder="Longitude (e.g. 76°59'09.1&quot;E)" value={lonQuery} onChange={e => setLonQuery(e.target.value)} />
          <button onClick={handleAddCoords}>Add by Coordinates</button>
        </div>

        <button className="secondary" onClick={optimizeRoute} style={{ width: '100%', marginBottom: '8px' }}>Optimize order</button>
        <div className="add-row">
          <button className="secondary" style={{ flex: 1 }} onClick={() => exportMap('img')}>Save Map (PNG)</button>
          <button className="secondary" style={{ flex: 1 }} onClick={() => exportMap('pdf')}>Save as PDF</button>
        </div>
        
        <ul id="stops">
          {stops.map((s, i) => (
            <li key={s.id}>
              <span className="name" onClick={() => zoomToLocation(i)} title="Click to view on map">
                {i+1}. {s.name}
              </span>
              <button onClick={() => renameStop(i)} title="Rename">✎</button>
              <button onClick={() => removeStop(i)}>✕</button>
            </li>
          ))}
        </ul>

        <div id="legs">
          {legsUI.map((leg, i) => (
            <div key={i} className="leg">
              <b>{leg.from}</b> → <b>{leg.to}</b>: {leg.km} km {leg.type === 'routed' ? `(~${leg.mins} min)` : '(straight-line)'}
            </div>
          ))}
        </div>
        <div id="total">{totalText}</div>
        <div id="status">{status}</div>
      </div>
      
      <div id="map" ref={mapContainerRef}></div>

      {/* NEW: Floating Fit Map Button */}
      {stops.length > 0 && (
        <button className="fit-map-btn" onClick={fitMap} title="Fit all locations on screen">
          ⛶ Fit Map
        </button>
      )}

    </div>
  );
}