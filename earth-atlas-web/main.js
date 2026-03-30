// Initialize Three.js variables
let scene, camera, renderer, particles, uniforms;
let raycaster, mouse;
let conflictHitboxes = []; // To store invisible meshes for raycasting
let earthSphere = null; // Global reference to the core sphere
let currentHoveredObject = null; // Currently selected conflict
let currentCameraShake = 0; // Severity of the camera shake effect
let targetRadiation = 0.0; // Decay target for the radiation effect on hover
let autoRotate = true; // Flag for automatic Earth rotation
const tooltip = document.getElementById('conflict-tooltip');
const RADIUS = 100;
const POINTS_COUNT = 200000; // Dense point cloud

// Audio Context Variables
let audioCtx;
let droneOsc, droneGain;
let isAudioInitialized = false;

init();
animate();

function init() {
    // 1. Scene Setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030308); // Near-black with a hint of deep blue

    // 2. Camera Setup
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);
    camera.position.z = window.innerWidth < 768 ? 400 : 250;

    // 3. Renderer Setup
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // 4. Controls
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1; // Less damping, more abrupt
    controls.enablePan = false;
    controls.minDistance = 150;
    controls.maxDistance = 600;
    controls.rotateSpeed = 0.8; // Faster, less elegant rotation

    // 5. Interaction Setup
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // 6. Fetch conflicts data
    fetch('conflicts.json')
        .then(response => response.json())
        .then(data => createGlobe(data))
        .catch(error => {
            console.error('Error fetching conflicts data:', error);
            createGlobe([]);
        });

    window.addEventListener('resize', onWindowResize, false);
    
    let isPointerDown = false;
    let isDraggingGlobe = false;
    let pointerDownPos = new THREE.Vector2();

    window.addEventListener('pointerdown', (e) => {
        isPointerDown = true;
        pointerDownPos.set(e.clientX, e.clientY);
        isDraggingGlobe = false;
        processInteraction(e.clientX, e.clientY);
    });

    window.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch' && !isPointerDown) return;
        
        if (isPointerDown) {
            if (pointerDownPos.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 5) {
                isDraggingGlobe = true;
            }
        }
        if (!isDraggingGlobe) {
            processInteraction(e.clientX, e.clientY);
        }
    });

    window.addEventListener('pointerup', (e) => {
        isPointerDown = false;
        setTimeout(() => { isDraggingGlobe = false; }, 50);
    });
    
    // Stop automatic rotation when user interacts with the canvas via OrbitControls
    controls.addEventListener('start', () => { 
        autoRotate = false; 
        if (typeof updateAutoRotateBtnUI === 'function') {
            updateAutoRotateBtnUI();
        }
    });
    
    // Initialize audio on first user interaction to bypass browser auto-play bans
    window.addEventListener('click', initAudio, { once: true });
    window.addEventListener('keydown', initAudio, { once: true });
}

function initAudio() {
    if (isAudioInitialized) return;
    
    // Set up Web Audio Context
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
    
    // 1. Create oppressive background drone
    droneOsc = audioCtx.createOscillator();
    droneOsc.type = 'sawtooth';
    droneOsc.frequency.setValueAtTime(45, audioCtx.currentTime); // Deep, unpleasant sub-bass
    
    const lfo = audioCtx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.2, audioCtx.currentTime); // Very slow detune
    
    const lfoGain = audioCtx.createGain();
    lfoGain.gain.setValueAtTime(5, audioCtx.currentTime);
    lfo.connect(lfoGain);
    lfoGain.connect(droneOsc.frequency);
    lfo.start();
    
    droneGain = audioCtx.createGain();
    droneGain.gain.setValueAtTime(0.05, audioCtx.currentTime); // Very quiet but omnipresent
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(150, audioCtx.currentTime); // Muffle high frequencies
    
    droneOsc.connect(filter);
    filter.connect(droneGain);
    droneGain.connect(audioCtx.destination);
    
    droneOsc.start();
    isAudioInitialized = true;
}

// Play a harsh, static/geiger-like click
function playGeigerClick(intensity) {
    if (!isAudioInitialized || !audioCtx) return;
    
    const bufferSize = audioCtx.sampleRate * 0.05; // 50ms of noise
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    
    const noiseSource = audioCtx.createBufferSource();
    noiseSource.buffer = buffer;
    
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 4000; // Thin, metallic sound
    
    const noiseGain = audioCtx.createGain();
    // Sharper, louder click for high intensity
    noiseGain.gain.setValueAtTime(intensity * 0.4, audioCtx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.04);
    
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(audioCtx.destination);
    
    noiseSource.start();
}

function clearTooltip() {
    currentHoveredObject = null;
    tooltip.classList.remove('visible');
    document.body.style.cursor = 'default';
    currentCameraShake *= 0.9;
    targetRadiation = 0.0;
}

function processInteraction(clientX, clientY) {
    // Calculate mouse position in normalized device coordinates (-1 to +1)
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    if (conflictHitboxes.length > 0) {
        raycaster.setFromCamera(mouse, camera);
        
        const objectsToTest = earthSphere ? [earthSphere, ...conflictHitboxes] : conflictHitboxes;
        const intersects = raycaster.intersectObjects(objectsToTest);

        if (intersects.length > 0 && intersects[0].object !== earthSphere) {
            const hitObj = intersects[0].object;
            const hit = hitObj.userData;
            
            if (currentHoveredObject !== hitObj) {
                currentHoveredObject = hitObj;
                
                // Update uniforms for the radiation shader effect
                uniforms.uHoveredClusterId.value = hit.clusterId;
                targetRadiation = 1.0;
                
                // Populate tooltip content forcefully
                let content = `<h3>${hit.isHigh ? '!!! CRITICAL INFARCTION !!!' : 'ANOMALY DETECTED'}</h3>`;
                
                if (hit.fatalities) {
                    content += `
                        <div class="meta-row">
                            <span class="meta-label">CASUALTIES</span>
                            <span class="meta-value fatalities-value" data-target="${hit.fatalities}">0</span>
                        </div>
                    `;
                }
                if (hit.events) {
                    content += `
                        <div class="meta-row">
                            <span class="meta-label">RECENT INCIDENTS</span>
                            <span class="meta-value">${hit.events}</span>
                        </div>
                    `;
                }
                if (hit.primary_actors) {
                    content += `<div class="actors">> INFECTION STRAIN: ${hit.primary_actors.toUpperCase()}</div>`;
                } else if (hit.info) {
                   content += `<div class="actors">> STRAIN: ${hit.info.toUpperCase()}</div>`;
                }
                
                tooltip.innerHTML = content;
                
                // Initiate rapid counter effect for fatalities
                const fatalitiesElem = tooltip.querySelector('.fatalities-value');
                if (fatalitiesElem) {
                    const target = parseInt(fatalitiesElem.getAttribute('data-target'), 10);
                    animateCounter(fatalitiesElem, target, 200); // Faster, brutal counter
                }
                
                // Camera Shake Toxicity
                currentCameraShake = hit.isHigh ? 0.8 : (hit.intensity > 0 ? 0.3 : 0.0);
                
                // Audio Feedback (Geiger counter effect based on severity and random chance)
                if (isAudioInitialized && Math.random() < currentCameraShake) {
                    playGeigerClick(currentCameraShake);
                }
                
                // Styling based on intensity
                if (hit.isHigh) {
                    tooltip.classList.add('high-intensity');
                } else {
                    tooltip.classList.remove('high-intensity');
                }
                
                tooltip.style.opacity = '1';
                tooltip.classList.add('visible');
                document.body.style.cursor = 'crosshair';
            }
        } else {
            clearTooltip();
        }
    } else {
        clearTooltip();
    }
}

function latLonToVector3(lat, lon, r) {
    const phi = lat * (Math.PI / 180);
    const theta = lon * (Math.PI / 180);

    const x = r * Math.cos(phi) * Math.sin(theta);
    const y = r * Math.sin(phi);
    const z = r * Math.cos(phi) * Math.cos(theta);

    return new THREE.Vector3(x, y, z);
}

// Generate an even distribution of points on a sphere using Fibonacci spiral
function generateFibonacciSphere(samples, radius) {
    const points = [];
    const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle

    for (let i = 0; i < samples; i++) {
        const y = 1 - (i / (samples - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = phi * i;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        points.push(new THREE.Vector3(x * radius, y * radius, z * radius));
    }
    return points;
}

// Simple hash-based pseudo-noise for procedural elevation
function hashNoise(x, y, z) {
    let n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return n - Math.floor(n);
}

// Smooth procedural noise via interpolation of hash values
function proceduralElevation(x, y, z) {
    // Multi-octave noise for natural-looking terrain
    const scale1 = 0.03, scale2 = 0.07, scale3 = 0.15;

    const n1 = hashNoise(x * scale1, y * scale1, z * scale1);
    const n2 = hashNoise(x * scale2 + 5.3, y * scale2 + 1.7, z * scale2 + 9.1);
    const n3 = hashNoise(x * scale3 + 13.5, y * scale3 + 7.2, z * scale3 + 3.8);

    // Weighted sum — large features dominate, small features add detail
    return n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
}

// Compute UV from a 3D point on the sphere
function pointToUV(pt, radius) {
    const u = 0.5 + (Math.atan2(pt.x, pt.z) / (2 * Math.PI));
    const v = 0.5 + (Math.asin(pt.y / radius) / Math.PI);
    return { u, v };
}

function createGlobe(conflictsData) {
    const loader = new THREE.TextureLoader();

    // Load specular map for land/sea masking
    const specularUrl = 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_specular_2048.jpg';

    loader.load(specularUrl, (specTexture) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const img = specTexture.image;
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        const geometry = new THREE.BufferGeometry();
        const positions = [];
        const intensities = [];
        const isHighIntensities = [];
        const historicalTensions = [];
        const eventCategories = [];
        const clusterIds = [];
        const elevations = [];
        const coastlines = [];

        // Generate base sphere points
        const basePoints = generateFibonacciSphere(POINTS_COUNT, RADIUS);

        // Prepare conflict centers
        const conflictCenters = conflictsData.map((c, idx) => ({
            pos: latLonToVector3(c.lat, c.lon, RADIUS),
            intensity: c.intensity,
            isHigh: c.is_high_intensity,
            isHistorical: c.historical_tension,
            eventCategory: c.event_category || 0.0,
            clusterId: idx + 1.0 // 1-based index
        }));

        // Pre-compute land flags for coastline detection
        const landFlags = basePoints.map(pt => {
            const { u, v } = pointToUV(pt, RADIUS);
            const x = Math.floor(u * canvas.width) % canvas.width;
            const y = Math.floor((1 - v) * canvas.height) % canvas.height;
            const index = (y * canvas.width + x) * 4;
            return imageData[index] < 50; // dark = land on specular map
        });

        basePoints.forEach((pt, idx) => {
            if (!landFlags[idx]) return; // Skip water

            // Procedural elevation from noise
            const elevation = proceduralElevation(pt.x, pt.y, pt.z);

            // Coastline detection: check if nearby Fibonacci neighbors are water
            // Use a simpler UV-offset approach
            const { u, v } = pointToUV(pt, RADIUS);
            let isCoast = 0.0;
            const offset = 0.008;
            const offsets = [
                [offset, 0], [-offset, 0], [0, offset], [0, -offset]
            ];
            for (const [du, dv] of offsets) {
                const nu = (u + du + 1) % 1;
                const nv = Math.max(0, Math.min(1, v + dv));
                const nx = Math.floor(nu * canvas.width) % canvas.width;
                const ny = Math.floor((1 - nv) * canvas.height) % canvas.height;
                const ni = (ny * canvas.width + nx) * 4;
                if (imageData[ni] >= 50) { // neighbor is water
                    isCoast = 1.0;
                    break;
                }
            }

            positions.push(pt.x, pt.y, pt.z);

            let pointIntensity = 0.0;
            let isHigh = 0.0;
            let isHistorical = 0.0;
            let evtCategory = 0.0;
            let closestClusterId = 0.0;
            let maxWeight = 0.0;

            for (let j = 0; j < conflictCenters.length; j++) {
                const conflict = conflictCenters[j];
                const dist = pt.distanceTo(conflict.pos);
                // Global Scale: Reduce influence radii significantly
                const influenceRadius = conflict.isHigh ? 4 : (conflict.isHistorical ? 1.5 : 2.5);

                if (dist < influenceRadius) {
                    const normalizedDist = dist / influenceRadius;
                    const weight = 1.0 - Math.pow(normalizedDist, 2);
                    pointIntensity += conflict.intensity * weight;
                    if (conflict.isHigh) isHigh = 1.0;
                    if (conflict.isHistorical) isHistorical = 1.0;
                    if (conflict.eventCategory > 0) evtCategory = conflict.eventCategory;
                    
                    if (weight > maxWeight) {
                        maxWeight = weight;
                        closestClusterId = conflict.clusterId;
                    }
                }
            }

            intensities.push(Math.min(1.0, pointIntensity));
            isHighIntensities.push(isHigh);
            historicalTensions.push(isHistorical);
            eventCategories.push(evtCategory);
            clusterIds.push(closestClusterId);
            elevations.push(elevation);
            coastlines.push(isCoast);
        });

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('aIntensity', new THREE.Float32BufferAttribute(intensities, 1));
        geometry.setAttribute('aIsHighIntensity', new THREE.Float32BufferAttribute(isHighIntensities, 1));
        geometry.setAttribute('aHistoricalTension', new THREE.Float32BufferAttribute(historicalTensions, 1));
        geometry.setAttribute('aEventType', new THREE.Float32BufferAttribute(eventCategories, 1));
        geometry.setAttribute('aClusterId', new THREE.Float32BufferAttribute(clusterIds, 1));
        geometry.setAttribute('aElevation', new THREE.Float32BufferAttribute(elevations, 1));
        geometry.setAttribute('aCoastline', new THREE.Float32BufferAttribute(coastlines, 1));

        uniforms = {
            uTime: { value: 0.0 },
            uHoveredClusterId: { value: 0.0 },
            uRadiationIntensity: { value: 0.0 }
        };

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderCode,
            fragmentShader: fragmentShaderCode,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        particles = new THREE.Points(geometry, material);
        particles.rotation.y = 1.5;
        particles.rotation.x = 0.15;

        // Inner core — blocks see-through
        const coreGeometry = new THREE.SphereGeometry(RADIUS - 0.5, 64, 64);
        const coreMaterial = new THREE.MeshBasicMaterial({
            color: 0x06060c,
            depthWrite: true
        });
        earthSphere = new THREE.Mesh(coreGeometry, coreMaterial);
        scene.add(earthSphere);

        // Atmospheric halo — Fresnel glow
        const haloGeometry = new THREE.SphereGeometry(RADIUS + 3, 64, 64);
        const haloMaterial = new THREE.ShaderMaterial({
            vertexShader: haloVertexShader,
            fragmentShader: haloFragmentShader,
            transparent: true,
            depthWrite: false,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending
        });
        const halo = new THREE.Mesh(haloGeometry, haloMaterial);
        scene.add(halo);

        // Create invisible hitboxes for Raycasting
        const hitboxGeometry = new THREE.SphereGeometry(1.5, 8, 8); // Scale down for precision on global map
        const hitboxMaterial = new THREE.MeshBasicMaterial({ 
            visible: false // Crucial: make them invisible!
        });

        conflictsData.forEach((c, idx) => {
            const pos = latLonToVector3(c.lat, c.lon, RADIUS);
            const hitbox = new THREE.Mesh(hitboxGeometry, hitboxMaterial);
            hitbox.position.copy(pos);
            hitbox.userData = { ...c, clusterId: idx + 1.0 }; // Store data for tooltip and shader
            conflictHitboxes.push(hitbox);
            particles.add(hitbox); // Add to rotating points instead of scene
        });

        scene.add(particles);
    });
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    if (uniforms) {
        uniforms.uTime.value += 0.012; // Faster, more erratic time for shaders
        
        // Smoothly approach target radiation
        if (typeof targetRadiation !== 'undefined') {
            uniforms.uRadiationIntensity.value += (targetRadiation - uniforms.uRadiationIntensity.value) * 0.15;
            if (uniforms.uRadiationIntensity.value < 0.01) {
                uniforms.uHoveredClusterId.value = 0.0; // Clear it when completely faded out
            }
        }
    }

    if (particles && autoRotate) {
        particles.rotation.y += 0.0008; // Uneasy rotation
    }
    
    // --- Update Tooltip Position ---
    if (currentHoveredObject && tooltip.classList.contains('visible')) {
        const objectPos = new THREE.Vector3();
        currentHoveredObject.getWorldPosition(objectPos);
        
        // 1. Hide tooltip if behind globe
        const normal = objectPos.clone().normalize();
        const cameraToObj = new THREE.Vector3().subVectors(objectPos, camera.position);
        if (cameraToObj.dot(normal) > 0) {
            tooltip.style.opacity = '0';
        } else {
            tooltip.style.opacity = '1';
        }
        
        // 2. Project to screen
        objectPos.project(camera);
        let x = (objectPos.x * 0.5 + 0.5) * window.innerWidth;
        let y = -(objectPos.y * 0.5 - 0.5) * window.innerHeight;
        
        if (window.innerWidth < 768) {
            x = Math.min(x, window.innerWidth - 240); 
            y = Math.min(y, window.innerHeight - 150);
        }
        
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    }
    
    // Apply Camera Shake
    let shakeX = 0;
    let shakeY = 0;
    if (currentCameraShake > 0.05) {
        shakeX = (Math.random() - 0.5) * currentCameraShake * 2.0;
        shakeY = (Math.random() - 0.5) * currentCameraShake * 2.0;
        camera.position.x += shakeX;
        camera.position.y += shakeY;
    }

    renderer.render(scene, camera);
    
    // Restore camera position immediately to prevent drifting
    if (currentCameraShake > 0.05) {
        camera.position.x -= shakeX;
        camera.position.y -= shakeY;
    }
    
    // Naturally decay continuous shake if mouse isn't updating it
    currentCameraShake *= 0.95;
}

// Terminal-like rapid counter animation
function animateCounter(element, target, duration) {
    let start = 0;
    const startTimestamp = performance.now();
    const frame = (timestamp) => {
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        element.textContent = Math.floor(progress * target);
        if (progress < 1) {
            requestAnimationFrame(frame);
        } else {
            element.textContent = target; // Ensure it ends exactly on target
        }
    };
    requestAnimationFrame(frame);
}

// --- MODAL LOGIC ---
const aboutModal = document.getElementById('about-modal');
const btnAccept = document.getElementById('accept-modal');
const btnCloseX = document.getElementById('close-modal-x');
const btnTrigger = document.getElementById('about-trigger');

function closeModal() {
    aboutModal.classList.remove('modal-active');
}

function openModal() {
    aboutModal.classList.add('modal-active');
}

if (btnAccept && btnCloseX && btnTrigger && aboutModal) {
    btnAccept.addEventListener('click', closeModal);
    btnCloseX.addEventListener('click', closeModal);
    btnTrigger.addEventListener('click', openModal);

    // Close modal if clicking outside the box
    aboutModal.addEventListener('click', (e) => {
        if (e.target === aboutModal) {
            closeModal();
        }
    });
}

// --- AUTO ROTATE LOGIC ---
const autoRotateBtn = document.getElementById('auto-rotate-btn');

function updateAutoRotateBtnUI() {
    if (!autoRotateBtn) return;
    if (autoRotate) {
        autoRotateBtn.classList.add('active');
        autoRotateBtn.textContent = 'AUTO ROTATE: ON';
    } else {
        autoRotateBtn.classList.remove('active');
        autoRotateBtn.textContent = 'AUTO ROTATE: OFF';
    }
}

if (autoRotateBtn) {
    autoRotateBtn.addEventListener('click', () => {
        autoRotate = !autoRotate;
        updateAutoRotateBtnUI();
    });
}
