// 3D Perlin Noise implementation for shaders
const vertexShaderCode = `
// GLSL Classic 3D Perlin noise, requires an array and a permutation polynomial
vec4 mod289(vec4 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 x) {
    return mod289(((x*34.0)+1.0)*x);
}

vec4 taylorInvSqrt(vec4 r) {
    return 1.79284291400159 - 0.85373472095314 * r;
}

vec3 fade(vec3 t) {
    return t*t*t*(t*(t*6.0-15.0)+10.0);
}

// Classic Perlin noise
float cnoise(vec3 P) {
    vec3 Pi0 = floor(P); // Integer part for indexing
    vec3 Pi1 = Pi0 + vec3(1.0); // Integer part + 1
    Pi0 = mod(Pi0, 289.0);
    Pi1 = mod(Pi1, 289.0);
    vec3 Pf0 = fract(P); // Fractional part for interpolation
    vec3 Pf1 = Pf0 - vec3(1.0); // Fractional part - 1.0
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz;
    vec4 iz1 = Pi1.zzzz;

    vec4 ixy = permute(permute(ix) + iy);
    vec4 ixy0 = permute(ixy + iz0);
    vec4 ixy1 = permute(ixy + iz1);

    vec4 gx0 = ixy0 / 7.0;
    vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
    gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5);
    gy0 -= sz0 * (step(0.0, gy0) - 0.5);

    vec4 gx1 = ixy1 / 7.0;
    vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
    gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5);
    gy1 -= sz1 * (step(0.0, gy1) - 0.5);

    vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
    vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
    vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
    vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
    vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
    vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
    vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
    vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);

    vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 *= norm0.x;
    g010 *= norm0.y;
    g100 *= norm0.z;
    g110 *= norm0.w;
    vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 *= norm1.x;
    g011 *= norm1.y;
    g101 *= norm1.z;
    g111 *= norm1.w;

    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);

    vec3 fade_xyz = fade(Pf0);
    vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
}

uniform float uTime;
uniform float uHoveredClusterId;
uniform float uRadiationIntensity;

// Attributes passed from JS
attribute float aIntensity;
attribute float aIsHighIntensity;
attribute float aHistoricalTension;
attribute float aEventType;
attribute float aClusterId;
attribute float aElevation;
attribute float aCoastline;

varying float vIntensity;
varying float vIsHighIntensity;
varying float vHistoricalTension;
varying float vEventType;
varying float vClusterId;
varying float vElevation;
varying float vCoastline;

void main() {
    vIntensity = aIntensity;
    vIsHighIntensity = aIsHighIntensity;
    vHistoricalTension = aHistoricalTension;
    vEventType = aEventType;
    vClusterId = aClusterId;
    vElevation = aElevation;
    vCoastline = aCoastline;

    vec3 pos = position;

    // Apply strict radiation chaos if hovered
    bool isIrradiated = (aClusterId > 0.0 && abs(aClusterId - uHoveredClusterId) < 0.1);
    
    // Apply severe turbulence if intensity is very high, acting like a blister or infection
    if (isIrradiated) {
        float radNoise = cnoise(pos * 5.0 + uTime * 15.0); // frantic, fast moving noise
        vec3 normalDir = normalize(pos);
        pos += normalDir * (radNoise * 2.0 * uRadiationIntensity); // High displacement 
    } else if (aIsHighIntensity > 0.5) {
        float noise = cnoise(pos * 1.5 + uTime * 4.0); // Faster, sharper noise
        vec3 normalDir = normalize(pos);
        float amplitude = aIntensity * 0.8; // More distinct bulging
        pos += normalDir * (noise * amplitude);
    }

    // Subtle elevation displacement — push high-elevation points slightly outward
    vec3 normalDir = normalize(pos);
    pos += normalDir * (aElevation * 0.4);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);

    // Point size driven by elevation for relief effect
    float baseSize = 1.4 + aElevation * 0.8; // 1.4 to 2.2 based on elevation

    if (isIrradiated) {
        baseSize += (8.0 * uRadiationIntensity); // Explode the size
    } else if (aIsHighIntensity > 0.5) {
        baseSize = 2.0 + (aIntensity * 2.0); // Make highest peaks smaller
    } else if (aHistoricalTension > 0.5) {
        baseSize = 1.6;
    }

    // Coastline points slightly larger for definition
    if (aCoastline > 0.5) {
        baseSize += 0.3;
    }

    // Scale by distance
    gl_PointSize = baseSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const fragmentShaderCode = `
uniform float uTime;
uniform float uHoveredClusterId;
uniform float uRadiationIntensity;

varying float vIntensity;
varying float vIsHighIntensity;
varying float vHistoricalTension;
varying float vEventType;
varying float vClusterId;
varying float vElevation;
varying float vCoastline;

void main() {
    // Soft circular point with smooth edge
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    float alpha = 1.0 - smoothstep(0.35, 0.5, dist);

    if (alpha < 0.01) discard;

    // Lifeless, ashen monochromatic base — Abyssal and necrotic
    vec3 baseColor = mix(
        vec3(0.08, 0.08, 0.09),  // low elevation — almost pure black
        vec3(0.22, 0.22, 0.24),  // high elevation — sick grey
        vElevation
    );

    // Coastline emphasis — subtle brightness boost
    if (vCoastline > 0.5) {
        baseColor += vec3(0.06, 0.07, 0.09);
    }

    float baseOpacity = 0.30 + vElevation * 0.20; // 0.30 to 0.50
    bool isIrradiated = (vClusterId > 0.0 && abs(vClusterId - uHoveredClusterId) < 0.1);

    if (isIrradiated) {
        // Toxic blinding yellow/white radiation flash
        vec3 radColor = vec3(1.0, 1.0, 0.6 + sin(uTime * 30.0)*0.4); 
        baseColor = mix(baseColor, radColor, uRadiationIntensity);
        baseOpacity = mix(baseOpacity, 1.0, uRadiationIntensity);
    } else if (vIsHighIntensity > 0.5) {
        // High Intensity — Arrhythmic Heartbeat/Strobe Spasm
        // Create an irregular pulse using mod and step functions
        float t = uTime * 3.5 + vIntensity * 10.0;
        float beat1 = exp(-fract(t) * 10.0);
        float beat2 = exp(-fract(t - 0.35) * 8.0) * 0.6;
        float pulse = max(beat1, beat2); // Irregular double-beat
        
        vec3 hotColor = vec3(1.0, 0.1, 0.0); // Toxic blood orange
        
        if (vEventType > 2.5) { // Civilians
            hotColor = vec3(0.8, 0.0, 0.8); // Necrotic purple
        } else if (vEventType > 1.5) { // Explosions
            hotColor = vec3(0.9, 0.9, 0.0); // Phosphorus sick yellow
        } else if (vEventType > 0.5) { // Battles
            hotColor = vec3(1.0, 0.0, 0.0); // Pure blood red
        }
        
        // Add extreme brightness flash
        hotColor += (pulse * 0.8);
        baseColor = hotColor;
        baseOpacity = 0.6 + pulse * 0.4; // Sharp flashing opacity
    } else if (vHistoricalTension > 0.5) {
        // Historical frozen tension — cold pale necrotic white/blue
        baseColor = vec3(0.3, 0.35, 0.45);
        baseOpacity = 0.06;
    } else if (vIntensity > 0.0) {
        // Minor events — Sickly infection spreading
        vec3 modColor = vec3(0.6, 0.1, 0.0); // Dark dried blood
        baseColor = mix(baseColor, modColor, clamp(vIntensity * 2.5 + 0.5, 0.0, 1.0));
        baseOpacity = 0.45 + (vIntensity * 0.55); 
    }

    gl_FragColor = vec4(baseColor, baseOpacity * alpha);
}
`;

// Atmospheric halo shader — Fresnel-based glow
const haloVertexShader = `
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
    vNormal = normalize(normalMatrix * normal);
    vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const haloFragmentShader = `
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
    vec3 viewDir = normalize(-vPosition);
    float fresnel = 1.0 - dot(viewDir, vNormal);
    fresnel = pow(fresnel, 3.5);

    // Sickly pale grey atmospheric glow
    vec3 glowColor = vec3(0.15, 0.15, 0.18);
    float glowOpacity = fresnel * 0.15;

    gl_FragColor = vec4(glowColor, glowOpacity);
}
`;
