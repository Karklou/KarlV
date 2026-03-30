# CLAUDE.md — The Infected Globe

## Contexte du projet

Visualisation 3D de données climatiques NASA GISTEMP. Le globe représente les anomalies
thermiques comme une maladie organique : zones vertes saines vs pustules noires et nécrosées.
Narration visuelle pure — pas de dashboard, pas de graphiques. La géométrie EST la donnée.

Un projet antérieur (Groundswell) existe dans la même codebase. Ne pas le modifier.
Certains patterns de Groundswell peuvent être réutilisés : lighting setup, OrbitControls,
logique de rendu Three.js. Mais l'architecture de rendu est fondamentalement différente.

---

## Stack technique

- Three.js r128 (même version que Groundswell — ne pas upgrader)
- GLSL custom via ShaderMaterial (pas MeshStandardMaterial pour la Sphère B)
- Python 3 + xarray + numpy pour le pipeline ETL (prepare_thermal_data.py)
- HTML/CSS pur pour l'UI — aucun framework JS

---

## Architecture : Système à 3 Sphères

### Sphère A — Noyau de verre (rayon = 100)
- IcosahedronGeometry(100, 12)
- MeshPhysicalMaterial : transmission 0.9, ior 1.5, clearcoat 1.0, roughness 0.05
- STATIQUE — aucune déformation géométrique
- renderOrder = 1

### Sphère B — Épiderme (rayon = 100.2)
- IcosahedronGeometry(100.2, 64) — rayon quasi identique à A, pas 101
- ShaderMaterial custom OBLIGATOIRE
- transparent: true + depthWrite: false (obligatoire pour que le discard
  s'intègre correctement avec la Sphère A en dessous)
- renderOrder = 2
- Double déformation dans le Vertex Shader :
  1. Déplacement statique via heightmap (continents)
  2. Déplacement dynamique via Data3DTexture (anomalie thermique × bruit Voronoi)
- Fragment Shader : couleur verte → nécrose noire proportionnelle à la tension géométrique
- Océans : discard (pas alpha, discard)

### Sphère C — Fantôme (rayon = 102)
- Totalement invisible (material.visible = false)
- Lisse, non déformée
- Cible EXCLUSIVE du Raycaster — ne jamais raycaster sur la Sphère B

---

## Shaders — Règles critiques apprises en session

### UVs — TOUJOURS recalculer depuis la position normalisée

IcosahedronGeometry ne génère pas d'UVs sphériques fiables. Ne jamais utiliser
l'attribut `uv` natif pour lire une texture géographique. Toujours recalculer :

```glsl
vec3 n = normalize(position);
float u = 0.5 + atan(n.z, n.x) / (2.0 * 3.14159265);
float v = 0.5 - asin(n.y) / 3.14159265;
vec2 sphericalUV = vec2(u, v);
```

Si une ligne de couture verticale apparaît à ±180°, c'est un artefact connu
du atan — corriger avec une dérivée partielle sur u.

### Heightmap — encodage et inversion

La texture earth_specular_2048.jpg du repo Three.js encode :
  blanc = océans, noir = continents (contre-intuitif)

Inverser OBLIGATOIREMENT dans le shader :
  `float h = 1.0 - texture2D(heightMap, sphericalUV).r;`

### Vertex Shader (Sphère B)
```glsl
uniform sampler2D heightMap;      // Carte de hauteur continents (statique)
uniform sampler3D thermalData;    // Data3DTexture NASA
uniform float timeIndex;          // 0.0 à 1.0 (profondeur Z dans la texture)
uniform float displacementScale;  // Amplitude max de la pustule
uniform float geoScale;           // Amplitude du relief géographique (défaut 5.0)

// Déplacement géographique
float displacement = h > 0.1
  ? h * geoScale * (0.5 + h * 0.5)
  : 0.0;
displaced += normal * displacement;
```

### Fragment Shader (Sphère B)
```glsl
// Logique de nécrose (étape suivante)
vec3 healthyGreen = vec3(0.15, 0.35, 0.10);
vec3 necrosisBlack = vec3(0.05, 0.04, 0.03);
// tension = dérivée de la déformation organique (dFdx / dFdy)
vec3 finalColor = mix(healthyGreen, necrosisBlack, clamp(tension * factor, 0.0, 1.0));
```

---

## Pipeline de données (prepare_thermal_data.py)

Le script existe et tourne. Les données sont validées visuellement.

### Règle absolue
Ne jamais remplacer les NaN par 0.0. Utiliser -999.0 comme valeur sentinelle.
Le shader détecte cette valeur et n'applique aucun déplacement.

### État actuel
- NaN → -999.0 (corrigé)
- Export Float32Array + metadata.json
- Ordre mémoire : (time, lat, lon) = (depth, height, width) pour Data3DTexture

### Évolution prévue (ne pas implémenter avant validation visuelle complète)
- Quantification Uint8 (÷4 sur le poids du fichier)
- Reconstruction dans le shader : `realValue = (uint8Value / 255.0) * (max - min) + min`

---

## Lighting (valeurs validées, ne pas modifier)

```js
AmbientLight(0xffffff, 0.1)
DirectionalLight(0xffffff, 2.0)  position (100, 60, 100)  castShadow
DirectionalLight(0x00ffaa, 1.0)  position (-100, 0, 100)
DirectionalLight(0x0044ff, 3.0)  position (0, 0, -100)
```

PMREMGenerator + RoomEnvironment requis pour que transmission fonctionne.

---

## UI — Règles strictes

- Zéro texte 3D (pas de Sprite, pas de CSS2DObject)
- Tout le HUD est en HTML/CSS absolu positionné par-dessus le canvas
- Police monospace obligatoire pour les valeurs numériques
- Positionnement dynamique : `Vector3.project(camera)` → coordonnées écran
- Tremblement sur valeurs extrêmes : CSS `@keyframes`, pas Three.js

---

## Contrôle temporel

- Slider → `timeIndex` uniform (float 0.0 à 1.0)
- Inertie obligatoire dans animate() :
  `currentTime += (targetTime - currentTime) * 0.05`
- La maladie doit gonfler et se résorber organiquement, pas sauter

---

## Ce qui vient de Groundswell (réutilisable)

- Setup OrbitControls (enableDamping, enablePan false, minDistance 110, maxDistance 500)
- Setup lighting — valeurs validées ci-dessus
- PMREMGenerator pour l'environnement
- Pattern async init() avec fetch enchaînés

## Ce qui NE vient PAS de Groundswell

- ExtrudeGeometry + bendGeometryToSphere → incompatible avec les shaders
- MeshStandardMaterial → remplacé par ShaderMaterial sur la Sphère B
- Raycaster sur countriesGroup → ici frappe uniquement la Sphère C
- Toute la logique deck.gl / Mapbox

---

## Règles de travail

1. Planifier avant de coder un shader. Les erreurs GLSL sont silencieuses.
2. Ne jamais utiliser les UVs natifs d'IcosahedronGeometry — toujours recalculer.
3. depthWrite: false obligatoire sur tout ShaderMaterial avec discard.
4. Tester la Data3DTexture avec données synthétiques avant le vrai .bin NASA.
5. Ne jamais modifier prepare_thermal_data.py et main.js dans la même session.
6. Un seul type de déformation par session : relief géographique d'abord, pustules ensuite.
7. Si rendu cassé, vérifier dans cet ordre : sphericalUV → depthWrite → renderOrder → uniforms null.
8. Garder les shaders dans infecte_shaders.js, jamais inline.

---

## État d'avancement

- [x] Pipeline ETL corrigé (NaN → -999.0) et validé
- [x] Data3DTexture testée et validée visuellement
- [x] Sphère A — noyau de verre fonctionnel
- [x] Sphère B — relief géographique statique fonctionnel
- [ ] Sphère B — déformation thermique dynamique (pustules)
- [ ] Sphère B — fragment shader nécrose
- [ ] Sphère C — raycaster
- [ ] UI — slider temporel avec inertie
- [ ] UI — HUD clinique HTML/CSS

---

## Fichiers du projet

```
/
├── prepare_thermal_data.py     # Pipeline ETL — Python
├── thermal_anomalies.bin       # Généré (ignoré par git si > 50Mo)
├── metadata.json               # Généré par le pipeline
├── infecte.html                # Point d'entrée The Infected Globe
├── infecte_main.js             # Scène Three.js
├── infecte_shaders.js          # Vertex + Fragment shaders
├── index.html                  # Groundswell — NE PAS MODIFIER
├── style.css                   # Groundswell — NE PAS MODIFIER
├── main.js                     # Groundswell — NE PAS MODIFIER
├── shaders.js                  # Groundswell — NE PAS MODIFIER
├── global_pressure.json        # Groundswell
└── ETH_hotspots.json           # Groundswell
```