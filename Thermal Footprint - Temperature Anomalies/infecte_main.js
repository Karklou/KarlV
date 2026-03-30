/**
 * infecte_main.js
 * ───────────────
 * The Infected Globe — Fullscreen raycasting planet + donnees thermiques NASA.
 * Porte depuis realtime-planet-shader (Julien Sulpis) vers Three.js r128.
 *
 * Architecture :
 *   - PlaneGeometry(2,2) fullscreen quad
 *   - Fragment shader raycasting (sphere + textures + eclairage)
 *   - DataTexture dynamique pour les anomalies thermiques (180x90, 1 slice/frame)
 *   - Slider temporel avec inertie
 *
 * THREE est charge en global via infecte.html (CDN r128).
 */

import { vertexShader, fragmentShader } from './infecte_shaders.js';


// ─── CONSTANTES THERMIQUES ──────────────────────────────────────────────────

const THERMAL_WIDTH  = 180;  // lon cells
const THERMAL_HEIGHT = 90;   // lat cells
const SLICE_SIZE     = THERMAL_WIDTH * THERMAL_HEIGHT;
const DISPLAY_MIN    = -3.0; // °C — borne basse du range d'affichage
const DISPLAY_MAX    = 8.0;  // °C — borne haute
const DISPLAY_RANGE  = DISPLAY_MAX - DISPLAY_MIN;


// ─── RENDERER ───────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const canvas = renderer.domElement;


// ─── CAMERA (passthrough) ───────────────────────────────────────────────────

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);


// ─── SCENE ──────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();


// ─── UNIFORMS ───────────────────────────────────────────────────────────────

const quality = Math.min(window.devicePixelRatio, 2);

const uniforms = {
  // Globaux
  uTime:            { value: 0.0 },
  uQuality:         { value: quality },
  uResolution:      { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  uRotationOffset:  { value: 0.6 },
  uTiltOffset:      { value: 0.0 },

  // Geometrie planete
  uPlanetPosition:  { value: new THREE.Vector3(0.0, 0.0, -10.0) },
  uPlanetRadius:    { value: 2.0 },

  // Eclairage
  sunDirectionXY:   { value: new THREE.Vector2(1.0, 1.0) },
  uSunIntensity:    { value: 3.0 },
  uAmbientLight:    { value: 0.01 },

  // Atmosphere
  uAtmosphereColor:   { value: new THREE.Vector3(0.05, 0.3, 0.9) },
  uAtmosphereDensity: { value: 0.3 },

  // Nuages
  uCloudsDensity:   { value: 0.5 },

  // Textures Earth
  uEarthColor:    { value: null },
  uEarthBump:     { value: null },
  uEarthClouds:   { value: null },
  uEarthSpecular: { value: null },
  uEarthNight:    { value: null },
  uStars:         { value: null },

  // Thermique NASA
  uThermalAnomaly:   { value: null },
  uThermalIntensity: { value: 1.0 },
  uDisplayMin:       { value: DISPLAY_MIN },
  uDisplayMax:       { value: DISPLAY_MAX },

  // Pustules lumineuses (hotspot particles)
  uHotspotData:      { value: null },
  uHotspotCount:     { value: 0 },
};


// ─── FULLSCREEN QUAD ────────────────────────────────────────────────────────

const geometry = new THREE.PlaneGeometry(2, 2);
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader,
  fragmentShader,
  depthWrite: false,
  depthTest:  false,
});

const quad = new THREE.Mesh(geometry, material);
scene.add(quad);


// ─── TEXTURE LOADING (Earth) ────────────────────────────────────────────────

const loader = new THREE.TextureLoader();
const textureMap = {
  uEarthColor:    '2k_earth_color.jpeg',
  uEarthBump:     '2k_earth_bump.jpg',
  uEarthClouds:   '2k_earth_clouds.jpeg',
  uEarthSpecular: '2k_earth_specular.jpeg',
  uEarthNight:    '2k_earth_night.jpeg',
  uStars:         '4k_stars.jpg',
};

Object.entries(textureMap).forEach(([uniformName, filename]) => {
  loader.load(filename, (tex) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    uniforms[uniformName].value = tex;
  }, undefined, (err) => {
    console.error(`[Infected Globe] Erreur texture "${filename}":`, err);
  });
});


// ─── THERMAL DATA LOADING ───────────────────────────────────────────────────

let thermalData     = null;  // Float32Array brut (28M floats)
let thermalMetadata = null;
let totalMonths     = 0;

// Texture RGBA Uint8 reutilisee a chaque frame
const thermalRGBA    = new Uint8Array(SLICE_SIZE * 4);
const thermalTexture = new THREE.DataTexture(
  thermalRGBA,
  THERMAL_WIDTH,
  THERMAL_HEIGHT,
  THREE.RGBAFormat,
  THREE.UnsignedByteType
);
thermalTexture.wrapS     = THREE.ClampToEdgeWrapping;
thermalTexture.wrapT     = THREE.ClampToEdgeWrapping;
thermalTexture.minFilter = THREE.LinearFilter;
thermalTexture.magFilter = THREE.LinearFilter;
thermalTexture.flipY     = false;

uniforms.uThermalAnomaly.value = thermalTexture;


// ─── HOTSPOT PARTICLES ─────────────────────────────────────────────────────

const MAX_HOTSPOTS      = 800;
const HOTSPOT_THRESHOLD = 0.5;  // °C — seuil calibre pour zones jaune+orange+rouge+noir
const hotspotData       = new Float32Array(MAX_HOTSPOTS * 4);  // RGBA per hotspot
const hotspotTexture    = new THREE.DataTexture(
  hotspotData,
  MAX_HOTSPOTS,
  1,
  THREE.RGBAFormat,
  THREE.FloatType
);
hotspotTexture.minFilter = THREE.NearestFilter;
hotspotTexture.magFilter = THREE.NearestFilter;
hotspotTexture.wrapS     = THREE.ClampToEdgeWrapping;
hotspotTexture.wrapT     = THREE.ClampToEdgeWrapping;
hotspotTexture.needsUpdate = true;

uniforms.uHotspotData.value = hotspotTexture;


async function loadThermalData() {
  const loadingEl   = document.getElementById('loading');
  const progressEl  = document.getElementById('loading-progress');

  try {
    // Metadata
    const metaResp = await fetch('metadata.json');
    thermalMetadata = await metaResp.json();
    totalMonths     = thermalMetadata.time_range.total_months;

    if (progressEl) progressEl.textContent = 'Acquiring thermal records...';

    // Binary — avec progression
    const binResp   = await fetch('https://github.com/Karklou/KarlV/releases/download/v1.0/thermal_anomalies.bin');
    const reader    = binResp.body.getReader();
    const totalSize = thermalMetadata.total_bytes;
    let received    = 0;
    const chunks    = [];
    const barFill   = document.getElementById('loading-bar-fill');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const pct = Math.round(received / totalSize * 100);
      if (progressEl) {
        progressEl.textContent = `Spread: ${pct}%`;
      }
      if (barFill) barFill.style.width = pct + '%';
    }

    // Assemblage
    const allBytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      allBytes.set(chunk, offset);
      offset += chunk.length;
    }
    thermalData = new Float32Array(allBytes.buffer);

    console.log(`[Infected Globe] Donnees thermiques chargees : ${totalMonths} mois, ${thermalData.length} floats`);

    // Charger le premier mois (debut de l'histoire, pas la fin)
    setTimeSlice(0);
    targetTimeIndex = 0;
    smoothTimeIndex = 0;
    const slider = document.getElementById('time-slider');
    if (slider) { slider.max = totalMonths - 1; slider.value = 0; }

    // Masquer loading, afficher la modale narrative
    if (loadingEl) loadingEl.style.display = 'none';
    showIntroModal();

  } catch (err) {
    console.error('[Infected Globe] Erreur chargement donnees thermiques:', err);
    if (progressEl) progressEl.textContent = 'Data loading error.';
  }
}


// ─── EXTRACTION D'UNE TRANCHE TEMPORELLE ────────────────────────────────────

let currentSliceIndex = -1;

function setTimeSlice(monthIndex) {
  if (!thermalData || monthIndex === currentSliceIndex) return;

  monthIndex = Math.max(0, Math.min(totalMonths - 1, Math.round(monthIndex)));
  currentSliceIndex = monthIndex;

  const sliceOffset = monthIndex * SLICE_SIZE;

  for (let i = 0; i < SLICE_SIZE; i++) {
    const val = thermalData[sliceOffset + i];
    const idx = i * 4;

    if (val < -900.0) {
      // Sentinel : pas de donnees
      thermalRGBA[idx]     = 0;
      thermalRGBA[idx + 1] = 0;
      thermalRGBA[idx + 2] = 0;
      thermalRGBA[idx + 3] = 0;
    } else {
      // Normalisation vers [0, 255]
      const normalized = (val - DISPLAY_MIN) / DISPLAY_RANGE;
      thermalRGBA[idx]     = Math.max(0, Math.min(255, Math.round(normalized * 255)));
      thermalRGBA[idx + 1] = 0;
      thermalRGBA[idx + 2] = 0;
      thermalRGBA[idx + 3] = 255;
    }
  }

  thermalTexture.needsUpdate = true;

  // ─── Extraction des hotspots pour les pustules lumineuses ──────
  const hotspots = [];
  for (let i = 0; i < SLICE_SIZE; i++) {
    const val = thermalData[sliceOffset + i];
    if (val > HOTSPOT_THRESHOLD && val < 900.0) {
      const col = i % THERMAL_WIDTH;
      const row = Math.floor(i / THERMAL_WIDTH);
      hotspots.push({
        u: (col + 0.5) / THERMAL_WIDTH,
        v: (row + 0.5) / THERMAL_HEIGHT,
        val
      });
    }
  }

  // Echantillonnage spatial uniforme — couvre TOUTES les bandes d'intensite
  // Au lieu de trier (qui ne garde que les plus chaudes), on prend 1 cellule sur N
  // pour garantir une distribution spatiale et thermique homogene
  const step = Math.max(1, Math.floor(hotspots.length / MAX_HOTSPOTS));
  let hCount = 0;

  for (let i = 0; i < hotspots.length && hCount < MAX_HOTSPOTS; i += step) {
    const h = hotspots[i];
    const normI = Math.min(1.0, (h.val - HOTSPOT_THRESHOLD) / (DISPLAY_MAX - HOTSPOT_THRESHOLD));
    const idx = hCount * 4;
    hotspotData[idx]     = h.u;                                         // R = longitude UV
    hotspotData[idx + 1] = h.v;                                         // G = latitude UV
    hotspotData[idx + 2] = normI;                                       // B = intensite normalisee
    hotspotData[idx + 3] = (h.u * 137.035 + h.v * 73.856) % 1.0;      // A = phase deterministe
    hCount++;
  }

  // Zero-fill les slots restants
  for (let i = hCount; i < MAX_HOTSPOTS; i++) {
    const idx = i * 4;
    hotspotData[idx] = hotspotData[idx + 1] = hotspotData[idx + 2] = hotspotData[idx + 3] = 0;
  }

  hotspotTexture.needsUpdate = true;
  uniforms.uHotspotCount.value = hCount;

  // Update HUD
  updateDateDisplay(monthIndex);
}


// ─── DATE DISPLAY ───────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

function monthIndexToDate(idx) {
  // Premier mois : 1880-01
  const year  = 1880 + Math.floor(idx / 12);
  const month = idx % 12;
  return { year, month, label: `${MONTH_NAMES[month]} ${year}` };
}

function updateDateDisplay(idx) {
  const dateEl = document.getElementById('date-display');
  if (!dateEl) return;
  const { year, label } = monthIndexToDate(idx);
  dateEl.textContent = label;
  updateMilestone(year);
}


// ─── JALONS TECHNOLOGIQUES ──────────────────────────────────────────────────

const MILESTONES = [
  { year: 1880, label: 'Mass industrialization' },
  { year: 1903, label: 'First powered flight' },
  { year: 1928, label: 'Discovery of penicillin' },
  { year: 1945, label: 'The atomic age' },
  { year: 1957, label: 'First satellite in orbit' },
  { year: 1969, label: 'Man walks on the Moon' },
  { year: 1983, label: 'Internet — TCP/IP protocol' },
  { year: 1990, label: 'Birth of the World Wide Web' },
  { year: 2001, label: 'Human genome sequenced' },
  { year: 2007, label: 'The smartphone era begins' },
  { year: 2016, label: 'AI defeats world Go champion' },
  { year: 2020, label: 'mRNA vaccine in 11 months' },
  { year: 2023, label: 'The AI arms race' },
];

function getMilestone(year) {
  // Trouve le jalon le plus recent <= annee courante
  let best = null;
  for (const m of MILESTONES) {
    if (m.year <= year) best = m;
    else break;
  }
  return best;
}

let currentMilestoneYear = -1;

function updateMilestone(year) {
  const el = document.getElementById('milestone');
  if (!el) return;
  const m = getMilestone(year);
  if (!m || m.year === currentMilestoneYear) return;
  currentMilestoneYear = m.year;
  el.style.opacity = '0';
  setTimeout(() => {
    el.textContent = m.year + ' — ' + m.label;
    el.style.opacity = '1';
  }, 300);
}


// ─── MODALE D'INTRODUCTION ─────────────────────────────────────────────────

function showIntroModal() {
  const modal = document.getElementById('intro-modal');
  const closeBtn = document.getElementById('intro-close');
  const titleEl = document.getElementById('title');
  const labelEl = document.getElementById('anomaly-label');

  if (modal) modal.classList.add('visible');

  const legendEl = document.getElementById('clinical-legend');

  const dismiss = () => {
    if (modal) modal.classList.remove('visible');
    // Reveal HUD + legend with fade
    if (titleEl) titleEl.style.opacity = '1';
    if (labelEl) labelEl.style.opacity = '1';
    if (legendEl) legendEl.style.opacity = '1';
    // Enable controls
    enableTimeControls();
  };

  if (closeBtn) closeBtn.addEventListener('click', dismiss);
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) dismiss();
  });
}


// ─── CONTROLES TEMPORELS ────────────────────────────────────────────────────

let targetTimeIndex  = 0;    // Cible du slider
let smoothTimeIndex  = 0;    // Valeur lissee (inertie)
let isPlaying        = false;
let playbackSpeed    = 6;    // Mois par seconde

function enableTimeControls() {
  const slider  = document.getElementById('time-slider');
  const playBtn = document.getElementById('play-btn');
  const controlsEl = document.getElementById('controls');

  if (controlsEl) controlsEl.style.display = 'flex';

  if (slider) {
    slider.max   = totalMonths - 1;
    // Ne pas ecraser la position — deja initialisee par loadThermalData

    slider.addEventListener('input', (e) => {
      targetTimeIndex = parseInt(e.target.value, 10);
      isPlaying = false;
      if (playBtn) playBtn.textContent = '▶';
    });
  }

  if (playBtn) {
    playBtn.addEventListener('click', () => {
      isPlaying = !isPlaying;
      playBtn.textContent = isPlaying ? '⏸' : '▶';
      // Si on est a la fin, rembobiner
      if (isPlaying && targetTimeIndex >= totalMonths - 1) {
        targetTimeIndex = 0;
        smoothTimeIndex = 0;
      }
    });
  }
}


// ─── INTERACTION : DRAG TO ROTATE ───────────────────────────────────────────

let isDragging       = false;
let prevX            = 0;
let prevY            = 0;
let rotationVelocity = 0;
let tiltVelocity     = 0;
let pinchStartDist   = 0;
let pinchStartRadius = 2.0;

canvas.addEventListener('mousedown', (e) => {
  isDragging = true;
  prevX = e.clientX;
  prevY = e.clientY;
  rotationVelocity = 0;
  tiltVelocity = 0;
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.clientX - prevX;
  const dy = e.clientY - prevY;
  uniforms.uRotationOffset.value += dx * 0.005;
  uniforms.uTiltOffset.value = Math.max(-1.2, Math.min(1.2, uniforms.uTiltOffset.value - dy * 0.005));
  rotationVelocity = dx * 0.005;
  tiltVelocity = -dy * 0.005;
  prevX = e.clientX;
  prevY = e.clientY;
});

canvas.addEventListener('mouseup',    () => { isDragging = false; });
canvas.addEventListener('mouseleave', () => { isDragging = false; });

// Touch
canvas.addEventListener('touchstart', (e) => {
  // On single touch : rotation. On multi-touch : zoom via pinch.
  if (e.touches.length === 1) {
    isDragging = true;
    prevX = e.touches[0].clientX;
    prevY = e.touches[0].clientY;
    rotationVelocity = 0;
    tiltVelocity = 0;
  } else if (e.touches.length === 2) {
    isDragging = false;
    pinchStartDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    pinchStartRadius = uniforms.uPlanetRadius.value;
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length === 1 && isDragging) {
    const dx = e.touches[0].clientX - prevX;
    const dy = e.touches[0].clientY - prevY;
    uniforms.uRotationOffset.value += dx * 0.005;
    uniforms.uTiltOffset.value = Math.max(-1.2, Math.min(1.2, uniforms.uTiltOffset.value - dy * 0.005));
    rotationVelocity = dx * 0.005;
    tiltVelocity = -dy * 0.005;
    prevX = e.touches[0].clientX;
    prevY = e.touches[0].clientY;
  } else if (e.touches.length === 2 && pinchStartDist > 0) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const scale = dist / pinchStartDist;
    uniforms.uPlanetRadius.value = Math.max(0.8, Math.min(4.0, pinchStartRadius * scale));
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) {
    isDragging = false;
    pinchStartDist = 0;
  }
});


// ─── INTERACTION : WHEEL TO ZOOM ────────────────────────────────────────────

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const current = uniforms.uPlanetRadius.value;
  uniforms.uPlanetRadius.value = Math.max(0.8, Math.min(4.0, current + e.deltaY * -0.002));
}, { passive: false });


// ─── RESIZE ─────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  uniforms.uResolution.value.set(w, h);
});


// ─── ANIMATE ────────────────────────────────────────────────────────────────

const rotationSpeed = 1.0;
let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);

  const dt = (now - lastTime) / 1000; // secondes
  lastTime = now;

  // Rotation auto
  uniforms.uTime.value += rotationSpeed * 0.01;

  // Inertie rotation (horizontale + verticale)
  if (!isDragging && Math.abs(rotationVelocity) > 0.0001) {
    uniforms.uRotationOffset.value += rotationVelocity;
    rotationVelocity *= 0.95;
  }
  if (!isDragging && Math.abs(tiltVelocity) > 0.0001) {
    uniforms.uTiltOffset.value = Math.max(-1.2, Math.min(1.2, uniforms.uTiltOffset.value + tiltVelocity));
    tiltVelocity *= 0.95;
  }

  // Playback temporel
  if (isPlaying && thermalData) {
    targetTimeIndex += playbackSpeed * dt;
    if (targetTimeIndex >= totalMonths - 1) {
      targetTimeIndex = totalMonths - 1;
      isPlaying = false;
      const playBtn = document.getElementById('play-btn');
      if (playBtn) playBtn.textContent = '▶';
    }

    const slider = document.getElementById('time-slider');
    if (slider) slider.value = Math.round(targetTimeIndex);
  }

  // Inertie temporelle (CLAUDE.md : currentTime += (targetTime - currentTime) * 0.05)
  if (thermalData) {
    smoothTimeIndex += (targetTimeIndex - smoothTimeIndex) * 0.08;
    setTimeSlice(Math.round(smoothTimeIndex));
  }

  renderer.render(scene, camera);
}

// ─── INIT ───────────────────────────────────────────────────────────────────

animate(performance.now());
loadThermalData();
