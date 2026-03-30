/**
 * infecte_shaders.js
 * ──────────────────
 * Shaders GLSL pour The Infected Globe.
 * Portage de realtime-planet-shader (Julien Sulpis) en WebGL1 pour Three.js r128.
 * + Injection thermique NASA GISTEMP.
 *
 * Architecture : fullscreen quad + raycasting en fragment shader.
 * La planete est calculee pixel par pixel — pas de mesh sphere.
 *
 * Licence shader original : MIT (Julien Sulpis)
 * https://github.com/jsulpis/realtime-planet-shader
 */


// ─── VERTEX SHADER ──────────────────────────────────────────────────────────

export const vertexShader = /* glsl */`
  varying vec2 vUv;
  varying vec3 vSunDirection;

  uniform vec2 uResolution;
  uniform vec2 sunDirectionXY;
  uniform float uQuality;

  void main() {
    vec2 resolution = uResolution * uQuality;
    vUv = (position.xy * 0.5) * resolution / min(resolution.y, resolution.x);
    vSunDirection = normalize(vec3(sunDirectionXY, 0.0));
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;


// ─── FRAGMENT SHADER ────────────────────────────────────────────────────────

export const fragmentShader = /* glsl */`
  precision highp float;

  varying vec2 vUv;
  varying vec3 vSunDirection;

  // ─── Uniforms globaux ─────────────────────────────────
  uniform float uTime;
  uniform float uRotationOffset;
  uniform float uTiltOffset;
  uniform vec2 uResolution;

  // ─── Textures Earth ───────────────────────────────────
  uniform sampler2D uEarthColor;
  uniform sampler2D uEarthClouds;
  uniform sampler2D uEarthSpecular;
  uniform sampler2D uEarthBump;
  uniform sampler2D uEarthNight;
  uniform sampler2D uStars;

  // ─── Textures thermiques NASA ─────────────────────────
  uniform sampler2D uThermalAnomaly;   // RGBA Uint8 : R=anomalie normalisee, A=masque donnees
  uniform float uThermalIntensity;     // Multiplicateur d'effet visuel (0 = off, 1 = normal)
  uniform float uDisplayMin;           // Borne basse du range d'affichage (°C)
  uniform float uDisplayMax;           // Borne haute du range d'affichage (°C)

  // ─── Hotspot particles (pustules lumineuses) ────────
  uniform sampler2D uHotspotData;      // 100x1 Float RGBA : R=u, G=v, B=intensite, A=phase
  uniform float uHotspotCount;         // Nombre de hotspots actifs

  // ─── Uniforms controlables ────────────────────────────
  uniform vec3  uPlanetPosition;
  uniform float uPlanetRadius;
  uniform float uCloudsDensity;
  uniform vec3  uAtmosphereColor;
  uniform float uAtmosphereDensity;
  uniform float uSunIntensity;
  uniform float uAmbientLight;

  // ─── Constantes ───────────────────────────────────────

  #define ROTATION_SPEED 0.05
  #define PLANET_ROTATION (rotateX(uTiltOffset) * rotateY(uTime * ROTATION_SPEED + uRotationOffset))

  #define CLOUD_COLOR vec3(1.0, 1.0, 1.0)
  #define SUN_COLOR vec3(1.0, 1.0, 0.9)
  #define DEEP_SPACE vec3(0.0, 0.0, 0.0005)

  #define INFINITY 1e10
  #define CAMERA_POSITION vec3(0.0, 0.0, 6.0)
  #define FOCAL_LENGTH (CAMERA_POSITION.z / (CAMERA_POSITION.z - uPlanetPosition.z))

  #define PI 3.14159265359
  #define MAX_HOTSPOTS 800
  

  // ─── Types ────────────────────────────────────────────

  struct Material {
    vec3  color;
    float diffuse;
    float specular;
    vec3  emission;
  };

  struct Hit {
    float len;
    vec3  normal;
    Material material;
  };

  struct Sphere {
    vec3  position;
    float radius;
  };

  // ─── Utilitaires ──────────────────────────────────────

  float inverseLerp(float v, float minValue, float maxValue) {
    return (v - minValue) / (maxValue - minValue);
  }

  float remap(float v, float inMin, float inMax, float outMin, float outMax) {
    float t = inverseLerp(v, inMin, inMax);
    return mix(outMin, outMax, t);
  }

  vec2 sphereProjection(vec3 p, vec3 origin) {
    vec3 dir = normalize(p - origin);
    float longitude = atan(dir.x, dir.z);
    float latitude  = asin(dir.y);
    return vec2(
      (longitude + PI) / (2.0 * PI),
      (latitude + PI / 2.0) / PI
    );
  }

  float sphIntersect(in vec3 ro, in vec3 rd, in Sphere sphere) {
    vec3  oc = ro - sphere.position;
    float b  = dot(oc, rd);
    float c  = dot(oc, oc) - sphere.radius * sphere.radius;
    float h  = b * b - c;
    if (h < 0.0) return -1.0;
    return -b - sqrt(h);
  }

  mat3 rotateY(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat3(
      vec3(c,   0.0, s),
      vec3(0.0, 1.0, 0.0),
      vec3(-s,  0.0, c)
    );
  }

  mat3 rotateX(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat3(
      vec3(1.0, 0.0, 0.0),
      vec3(0.0, c,  -s),
      vec3(0.0, s,   c)
    );
  }

  vec3 simpleReinhardToneMapping(vec3 color) {
    float exposure = 1.5;
    color *= exposure / (1.0 + color / exposure);
    color = pow(color, vec3(1.0 / 2.4));
    return color;
  }

  // ─── Reconstruction de l'anomalie depuis la texture ───

  float decodeAnomaly(vec4 thermalSample) {
    // R = anomalie normalisee [0,1] mappee sur [displayMin, displayMax]
    // A = 0 si sentinel (pas de donnees), 1 si donnees valides
    return thermalSample.r * (uDisplayMax - uDisplayMin) + uDisplayMin;
  }

  bool hasThermalData(vec4 thermalSample) {
    return thermalSample.a > 0.5;
  }

  // ─── Planete : bruit de surface + bump thermique ──────

  Sphere getPlanet() {
    return Sphere(uPlanetPosition, uPlanetRadius);
  }

  float planetNoise(vec3 p) {
    vec2  textureCoord = sphereProjection(p, uPlanetPosition);
    float bump         = texture2D(uEarthBump, textureCoord).r;
    float cloudsDensity = texture2D(uEarthClouds, textureCoord).r;

    float baseBump = 0.01 * mix(bump, max(bump, smoothstep(-0.5, 2.0, cloudsDensity)), uCloudsDensity);

    // ─── Bump thermique : les zones chaudes gonflent (pustules) ───
   vec4 thermalSample = texture2D(uThermalAnomaly, textureCoord);
    if (hasThermalData(thermalSample)) {
      float anomaly = decodeAnomaly(thermalSample);
      float t = max(0.0, anomaly);
      
      // Déformation organique subtile — lisible, pas de topographie chaotique
      float swell = (t * t * 0.002 + t * 0.005) * uThermalIntensity;
      
      baseBump += swell;
    }

    return baseBump;
  }

  float planetDist(in vec3 ro, in vec3 rd) {
    float smoothSphereDist = sphIntersect(ro, rd, getPlanet());
    vec3  intersection     = ro + smoothSphereDist * rd;
    vec3  rotated          = PLANET_ROTATION * (intersection - uPlanetPosition) + uPlanetPosition;
    return sphIntersect(ro, rd, Sphere(uPlanetPosition, uPlanetRadius + planetNoise(rotated)));
  }

  vec3 planetNormal(vec3 p) {
    vec3  rd   = uPlanetPosition - p;
    float dist = planetDist(p, rd);
    vec2  e    = vec2(max(0.01, 0.03 * smoothstep(1300.0, 300.0, uResolution.x)), 0.0);
    vec3  n    = dist - vec3(
      planetDist(p - e.xyy, rd),
      planetDist(p - e.yxy, rd),
      planetDist(p + e.yyx, rd)
    );
    return normalize(n);
  }

  // ─── Espace et atmosphere ─────────────────────────────

  vec3 spaceColor(vec3 direction) {
    vec3 backgroundCoord = direction * rotateY(uTime * ROTATION_SPEED / 3.0 + 1.5);
    vec2 textureCoord    = sphereProjection(backgroundCoord, vec3(0.0));
    textureCoord.x       = 1.0 - textureCoord.x;
    vec3 stars           = texture2D(uStars, textureCoord).rgb;
    return DEEP_SPACE + stars * stars * stars * 0.5;
  }

  vec3 atmosphereColor(vec3 ro, vec3 rd, float spaceMask) {
    float distOrigin = length(uPlanetPosition - CAMERA_POSITION);
    float distEdge   = sqrt(distOrigin * distOrigin - uPlanetRadius * uPlanetRadius);
    float planetMask = 1.0 - spaceMask;

    vec3  coordFromCenter = (ro + rd * distEdge) - uPlanetPosition;
    float distFromEdge    = abs(length(coordFromCenter) - uPlanetRadius);
    float planetEdge      = max(uPlanetRadius - distFromEdge, 0.0) / uPlanetRadius;
    float atmosphereMask  = pow(
      remap(dot(vSunDirection, coordFromCenter), -uPlanetRadius, uPlanetRadius / 2.0, 0.0, 1.0),
      5.0
    );
    atmosphereMask *= uAtmosphereDensity * uPlanetRadius * uSunIntensity;

    vec3 atmosphere  = vec3(pow(planetEdge, 120.0)) * 0.5;
    atmosphere      += pow(planetEdge, 50.0) * 0.3 * (1.5 - planetMask);
    atmosphere      += pow(planetEdge, 15.0) * 0.015;
    atmosphere      += pow(planetEdge, 5.0)  * 0.04 * planetMask;

    return atmosphere * uAtmosphereColor * atmosphereMask;
  }

  // ─── Ray Tracing + Injection thermique ────────────────

  Hit intersectPlanet(vec3 ro, vec3 rd) {
    float len = sphIntersect(ro, rd, getPlanet());
    if (len < 0.0) {
      return Hit(INFINITY, vec3(0.0), Material(vec3(0.0), -1.0, -1.0, vec3(-1.0)));
    }

    vec3 position        = ro + len * rd;
    vec3 rotatedPosition = PLANET_ROTATION * (position - uPlanetPosition) + uPlanetPosition;
    vec2 textureCoord    = sphereProjection(rotatedPosition, uPlanetPosition);

    // ─── Couleur de base ────────────────────────────────
    vec3  color    = texture2D(uEarthColor, textureCoord).rgb;
    vec3  normal   = planetNormal(position);
    float specular = texture2D(uEarthSpecular, textureCoord).r;

    // ─── Villes de nuit ─────────────────────────────────
    float nightLightIntensity = clamp(
      dot(-normal, vSunDirection) + 0.1,
      smoothstep(1.0, 0.0, pow(uSunIntensity + uAmbientLight, 0.3)),
      1.0
    );
    vec3 nightColor = pow(texture2D(uEarthNight, textureCoord).r, 3.0) * vec3(1.0, 0.8, 0.6);
    nightColor     *= nightLightIntensity;

    // ─── Nuages ─────────────────────────────────────────
    float cloudsDensity   = texture2D(uEarthClouds, textureCoord).r;
    float cloudsThreshold = 1.0 - uCloudsDensity;
    float smoothness      = uCloudsDensity * (1.0 - uCloudsDensity);
    cloudsDensity        *= smoothstep(cloudsThreshold - smoothness, cloudsThreshold, cloudsDensity);
    color                 = mix(color, CLOUD_COLOR, cloudsDensity);

    // ─── INFECTION THERMIQUE ────────────────────────────
    vec4 thermalSample = texture2D(uThermalAnomaly, textureCoord);
    if (hasThermalData(thermalSample) && uThermalIntensity > 0.01) {
      float anomaly = decodeAnomaly(thermalSample);

      // Anomalies positives : infection / necrose
      if (anomaly > 0.0) {
        // Phase 1 : fievre (0 → 2°C) — orange subtil
        // Phase 2 : infection (2 → 4°C) — rouge profond
        // Phase 3 : necrose (4°C+) — noir charbon
        float t = anomaly * uThermalIntensity;

        float feverPhase    = smoothstep(0.0, 1.5, t);
        float infectionPhase = smoothstep(1.0, 3.5, t);
        float necrosisPhase  = smoothstep(2.5, 5.5, t);

        vec3 feverColor    = vec3(0.75, 0.38, 0.02);  // orange chaud — visible mais pas saturé
        vec3 infectionColor = vec3(0.70, 0.05, 0.01);  // rouge profond
        vec3 necrosisColor  = vec3(0.05, 0.02, 0.01);  // noir charbon profond

        vec3 diseaseColor = mix(feverColor, infectionColor, infectionPhase);
        diseaseColor      = mix(diseaseColor, necrosisColor, necrosisPhase);

        // Gradient visible mais les pustules restent dominantes
        color = mix(color, diseaseColor, feverPhase * 0.85);

        // Les nuages se dissipent sur les zones necrosees
        // (la maladie brule l'atmosphere locale)
        nightColor *= (1.0 - necrosisPhase * 0.7);

        // Le specular diminue — surface mate, malade
        specular *= (1.0 - feverPhase * 0.6);
      }

      // Anomalies negatives : gel / cyanose (effet subtil)
      if (anomaly < -0.5) {
        float coldIntensity = smoothstep(-0.5, -2.5, anomaly) * uThermalIntensity;
        vec3 frostColor = vec3(0.25, 0.55, 1.00);
        color = mix(color, frostColor, coldIntensity * 0.55);
      }
    }

    // ─── PUSTULES LUMINEUSES (particules cosmetiques) ────
    vec3 particleGlow = vec3(0.0);
    int iHotspotCount = int(uHotspotCount);

    for (int i = 0; i < MAX_HOTSPOTS; i++) {
      if (i >= iHotspotCount) break;

      // Lecture de la donnee hotspot depuis la texture 100x1
      float texU = (float(i) + 0.5) / float(MAX_HOTSPOTS);
      vec4 hData = texture2D(uHotspotData, vec2(texU, 0.5));

      vec2  hUV        = hData.xy;
      float hIntensity = hData.z;
      float hPhase     = hData.w;

      if (hIntensity < 0.01) continue;

      // Distance UV spherique : correction wrap longitude + compression latitude
      float du = abs(textureCoord.x - hUV.x);
      du = min(du, 1.0 - du);                          // wrap antimeridien
      float dv = textureCoord.y - hUV.y;
      float latCorrect = cos((textureCoord.y - 0.5) * PI);
      du *= max(latCorrect, 0.1);                       // eviter division par zero aux poles
      float dist = sqrt(du * du + dv * dv);

      if (dist > 0.10) continue;                        // early exit — rayon elargi

      // Vitesse proportionnelle a la chaleur : tiede=lent, brulant=rapide
      float speed    = 1.5 + hIntensity * 4.0;
      float pulse    = 0.45 + 0.55 * sin(uTime * speed + hPhase * 6.2832);

      // Taille élargie et fusion des amas
      float baseSize = 0.018 + hIntensity * 0.035; 
      float sz       = baseSize * (0.6 + 0.4 * pulse);

      // Le halo externe est renforcé pour lier les particules entre elles
      float glow     = exp(-dist * dist / (sz * sz * 0.30));
      float ringDist = abs(dist - sz * 0.80);
      float ring     = exp(-ringDist * ringDist / (sz * sz * 0.012));
      float halo     = exp(-dist * dist / (sz * sz * 2.5)) * 0.45;

      

      float alpha = (glow + ring * 0.35 + halo) * hIntensity * pulse;

      // Palette complete suivant le gradient de base : jaune → orange → rouge → noir
      vec3 yellowWarm  = vec3(0.85, 0.65, 0.08);   // zones tièdes — jaune organique
      vec3 orangeHot   = vec3(0.90, 0.35, 0.00);   // zones chaudes — orange necrose
      vec3 redDeep     = vec3(0.85, 0.02, 0.00);   // zones brulantes — rouge sang
      vec3 necroBlack  = vec3(0.08, 0.01, 0.00);   // zones extremes — charbon

      vec3 pCol = mix(yellowWarm, orangeHot, smoothstep(0.0, 0.30, hIntensity));
      pCol = mix(pCol, redDeep, smoothstep(0.25, 0.55, hIntensity));
      pCol = mix(pCol, necroBlack, smoothstep(0.55, 0.85, hIntensity));
      pCol = mix(pCol, vec3(1.0, 0.90, 0.70), glow * glow * 0.5); // coeur incandescent

      particleGlow += pCol * alpha * 0.9;
    }

    return Hit(len, normal, Material(color, 1.0, specular, nightColor + particleGlow));
  }

  vec3 radiance(vec3 ro, vec3 rd) {
    vec3  color     = vec3(0.0);
    float spaceMask = 1.0;
    Hit   hit       = intersectPlanet(ro, rd);

    if (hit.len < INFINITY) {
      spaceMask = 0.0;

      // Diffuse
      float directLight = pow(clamp(dot(hit.normal, vSunDirection), 0.0, 1.0), 2.0) * uSunIntensity;
      vec3  diffuse     = hit.material.color * (uAmbientLight + directLight * SUN_COLOR);

      // Phong specular
      vec3  reflected = normalize(reflect(-vSunDirection, hit.normal));
      vec3  phongRd   = normalize(vec3(vUv * pow(FOCAL_LENGTH, -1.0), -1.0));
      float phong     = pow(max(0.0, dot(phongRd, reflected)), 8.0) * 0.2 * uSunIntensity;
      vec3  specular  = hit.material.specular * vec3(phong);

      color = diffuse + specular + hit.material.emission;
    } else {
      float zoomFactor = min(uResolution.x / uResolution.y, 1.0);
      vec3  bgRd       = normalize(vec3(vUv * zoomFactor, -1.0));
      color = spaceColor(bgRd);
    }

    return color + atmosphereColor(ro, rd, spaceMask);
  }

  // ─── Main ─────────────────────────────────────────────

  void main() {
    vec3 ro = CAMERA_POSITION;
    vec3 rd = normalize(vec3(vUv * FOCAL_LENGTH, -1.0));

    vec3 color = radiance(ro, rd);
    color = simpleReinhardToneMapping(color);
    color *= 1.0 - 0.5 * pow(length(vUv), 3.0);

    gl_FragColor = vec4(color, 1.0);
  }
`;
