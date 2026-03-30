"""
Pipeline de données : NASA GISTEMP → Three.js
Convertit les anomalies de température (NetCDF) en binaire Float32 + métadonnées JSON.

Usage:
    python prepare_thermal_data.py
"""

import json
import struct
from pathlib import Path

import numpy as np
import xarray as xr
from tqdm import tqdm

# ─── Configuration ───────────────────────────────────────────────────────────

INPUT_NC = Path(__file__).parent / "gistemp1200_GHCNv4_ERSSTv5.nc"
OUTPUT_BIN = Path(__file__).parent / "thermal_anomalies.bin"
OUTPUT_META = Path(__file__).parent / "metadata.json"
VARIABLE = "tempanomaly"


# ─── Étape 1 : Extraction ────────────────────────────────────────────────────

def load_dataset(path: Path) -> xr.DataArray:
    """Charge la variable tempanomaly depuis le fichier NetCDF."""
    print(f"[1/4] Chargement de {path.name}...")
    ds = xr.open_dataset(path)

    if VARIABLE not in ds:
        available = list(ds.data_vars)
        raise KeyError(f"Variable '{VARIABLE}' introuvable. Disponibles : {available}")

    data = ds[VARIABLE]
    print(f"      Dimensions : {dict(data.sizes)}")
    print(f"      Shape      : {data.shape}")
    return data


# ─── Étape 2 : Nettoyage ─────────────────────────────────────────────────────

def clean_data(data: xr.DataArray) -> np.ndarray:
    """Remplace les NaN par 0.0 et convertit en float32."""
    print("[2/4] Nettoyage des données (NaN → 0.0)...")
    values = data.values.astype(np.float32)
    nan_count = np.isnan(values).sum()
    total = values.size
    print(f"      NaN trouvés : {nan_count:,} / {total:,} ({nan_count / total * 100:.1f}%)")
    values = np.nan_to_num(values, nan=-999.0)
    return values


# ─── Étape 3 : Export binaire Float32 ────────────────────────────────────────

def export_binary(values: np.ndarray, path: Path) -> None:
    """
    Aplatit la matrice 3D (time × lat × lon) et l'écrit en Float32 brut.

    Ordre mémoire : time varie le plus lentement (axe 0 = depth),
    puis latitude (axe 1 = height), puis longitude (axe 2 = width).
    Compatible avec Three.js Data3DTexture(data, width, height, depth).
    """
    print(f"[3/4] Export binaire → {path.name}...")
    flat = values.flatten().astype(np.float32)

    # Écriture par blocs avec barre de progression
    chunk_size = 1_000_000  # floats par bloc
    total_floats = flat.size
    with open(path, "wb") as f:
        for start in tqdm(range(0, total_floats, chunk_size),
                          desc="      Écriture", unit="chunk"):
            end = min(start + chunk_size, total_floats)
            f.write(flat[start:end].tobytes())

    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"      Taille     : {size_mb:.1f} Mo")


# ─── Étape 4 : Métadonnées JSON ──────────────────────────────────────────────

def export_metadata(data: xr.DataArray, values: np.ndarray, path: Path) -> None:
    """Génère le fichier metadata.json pour Three.js."""
    print(f"[4/4] Export métadonnées → {path.name}...")

    time_coords = data.coords["time"]
    first = str(time_coords.values[0])[:10]
    last = str(time_coords.values[-1])[:10]

    # Dimensions : (time, lat, lon) → (depth, height, width)
    n_time, n_lat, n_lon = values.shape

    metadata = {
        "description": "NASA GISTEMP v4 — anomalies de température (°C vs 1951-1980)",
        "source_file": INPUT_NC.name,
        "dimensions": {
            "width": n_lon,
            "height": n_lat,
            "depth": n_time,
        },
        "axes": {
            "width": "longitude",
            "height": "latitude",
            "depth": "time (mois)",
        },
        "time_range": {
            "first": first,
            "last": last,
            "total_months": n_time,
        },
        "lat_range": [float(data.coords["lat"].values[0]),
                      float(data.coords["lat"].values[-1])],
        "lon_range": [float(data.coords["lon"].values[0]),
                      float(data.coords["lon"].values[-1])],
        "anomaly_stats": {
            "min": float(np.min(values)),
            "max": float(np.max(values)),
            "mean": round(float(np.mean(values)), 4),
        },
        "encoding": "Float32Array",
        "byte_order": "little-endian",
        "total_floats": int(values.size),
        "total_bytes": int(values.size * 4),
    }

    with open(path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)

    print(f"      OK — {n_lon}×{n_lat}×{n_time} = {values.size:,} valeurs")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  Pipeline GISTEMP → Three.js (Float32 binaire)")
    print("=" * 60)
    print()

    data = load_dataset(INPUT_NC)
    values = clean_data(data)
    export_binary(values, OUTPUT_BIN)
    export_metadata(data, values, OUTPUT_META)

    print()
    print("✓ Pipeline terminé.")
    print(f"  → {OUTPUT_BIN.name}  (données brutes)")
    print(f"  → {OUTPUT_META.name} (structure pour Three.js)")


if __name__ == "__main__":
    main()
