"""
Pipeline de données : NASA GISTEMP → Three.js
Convertit les anomalies de température (NetCDF) en binaire Uint8 + métadonnées JSON.

Encodage Uint8 :
    255        → sentinelle "pas de données" (NaN dans le NetCDF d'origine)
    0 – 254    → valeur quantifiée, reconstruite côté JS par :
                 val = (uint8 / 254.0) * (real_max - real_min) + real_min

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
    """Remplace les NaN par la sentinelle -999.0 et convertit en float32."""
    print("[2/5] Nettoyage des données (NaN → -999.0)...")
    values = data.values.astype(np.float32)
    nan_count = np.isnan(values).sum()
    total = values.size
    print(f"      NaN trouvés : {nan_count:,} / {total:,} ({nan_count / total * 100:.1f}%)")
    values = np.nan_to_num(values, nan=-999.0)
    return values


# ─── Étape 3 : Quantification Uint8 ──────────────────────────────────────────

def quantize_uint8(values: np.ndarray) -> tuple:
    """
    Quantifie les anomalies float32 en Uint8.

    Encodage :
        255      → sentinelle "pas de données" (valeur float < -900)
        0 – 254  → anomalie valide, reconstruite par :
                   val = (uint8 / 254.0) * (real_max - real_min) + real_min

    Retourne (quantized: uint8 ndarray, real_min: float, real_max: float).
    """
    print("[3/5] Quantification Uint8...")

    mask = values > -900.0          # True = données valides
    valid = values[mask]
    real_min = float(valid.min())
    real_max = float(valid.max())
    data_range = real_max - real_min

    print(f"      Plage réelle  : [{real_min:.4f}, {real_max:.4f}] °C")
    print(f"      Résolution    : {data_range / 254.0:.4f} °C / niveau")

    quantized = np.full(values.shape, 255, dtype=np.uint8)   # 255 = sentinel
    scaled = (valid - real_min) / data_range * 254.0
    quantized[mask] = np.clip(np.round(scaled), 0, 254).astype(np.uint8)

    print(f"      Erreur max    : {data_range / 254.0 / 2:.4f} °C (±½ niveau)")
    return quantized, real_min, real_max


# ─── Étape 4 : Export binaire Uint8 ──────────────────────────────────────────

def export_binary(values: np.ndarray, path: Path) -> None:
    """
    Aplatit la matrice 3D (time × lat × lon) et l'écrit en Uint8 brut.

    Ordre mémoire : time varie le plus lentement (axe 0 = depth),
    puis latitude (axe 1 = height), puis longitude (axe 2 = width).
    1 octet par valeur (vs 4 en Float32 → ÷4 sur la taille).
    """
    print(f"[4/5] Export binaire → {path.name}...")
    flat = values.flatten()   # déjà uint8

    chunk_size = 4_000_000    # octets par bloc
    total_bytes = flat.size
    with open(path, "wb") as f:
        for start in tqdm(range(0, total_bytes, chunk_size),
                          desc="      Écriture", unit="chunk"):
            end = min(start + chunk_size, total_bytes)
            f.write(flat[start:end].tobytes())

    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"      Taille     : {size_mb:.1f} Mo  (était ~{size_mb * 4:.0f} Mo en Float32)")


# ─── Étape 5 : Métadonnées JSON ──────────────────────────────────────────────

def export_metadata(data: xr.DataArray, values: np.ndarray,
                    real_min: float, real_max: float, path: Path) -> None:
    """Génère le fichier metadata.json pour Three.js (format Uint8)."""
    print(f"[5/5] Export métadonnées → {path.name}...")

    time_coords = data.coords["time"]
    first = str(time_coords.values[0])[:10]
    last = str(time_coords.values[-1])[:10]

    # Dimensions : (time, lat, lon) → (depth, height, width)
    n_time, n_lat, n_lon = values.shape

    # Statistiques sur les données valides uniquement (exclut la sentinelle 255)
    valid_mask = values < 255
    valid_uint8 = values[valid_mask]

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
        "encoding": "Uint8",
        "quantization": {
            "sentinel": 255,
            "valid_range_uint8": [0, 254],
            "real_min": real_min,
            "real_max": real_max,
            "formula": "val_celsius = (uint8 / 254.0) * (real_max - real_min) + real_min",
        },
        "anomaly_stats": {
            "valid_cells": int(valid_uint8.size),
            "sentinel_cells": int(values.size - valid_uint8.size),
            "real_min_celsius": real_min,
            "real_max_celsius": real_max,
        },
        "total_values": int(values.size),
        "total_bytes": int(values.size),   # 1 octet par valeur
    }

    with open(path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)

    print(f"      OK — {n_lon}×{n_lat}×{n_time} = {values.size:,} valeurs")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  Pipeline GISTEMP → Three.js (Uint8 quantifié)")
    print("=" * 60)
    print()

    data        = load_dataset(INPUT_NC)
    values_f32  = clean_data(data)
    values_u8, real_min, real_max = quantize_uint8(values_f32)
    export_binary(values_u8, OUTPUT_BIN)
    export_metadata(data, values_u8, real_min, real_max, OUTPUT_META)

    print()
    print("✓ Pipeline terminé.")
    print(f"  → {OUTPUT_BIN.name}  (Uint8, ~{OUTPUT_BIN.stat().st_size / 1024**2:.0f} Mo)")
    print(f"  → {OUTPUT_META.name} (structure + quantization pour Three.js)")


if __name__ == "__main__":
    main()
