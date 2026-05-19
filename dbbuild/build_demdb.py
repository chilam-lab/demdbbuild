#!/usr/bin/env python3
# Script ETL para DEM WorldClim:
# 1) recorta raster a AOI (Américas),
# 2) discretiza elevación en bins,
# 3) vectoriza bins,
# 4) carga resultados y metadatos en PostGIS.
import argparse
import logging
import os
import re
import subprocess
import sys
from pathlib import Path



BASE_DIR = Path(__file__).resolve().parent
# Estructura de carpetas del proyecto.
DATA_DIR = BASE_DIR / "data"
INPUT_DIR = DATA_DIR / "input"
OUTPUT_DIR = DATA_DIR / "output"
RASTER_OUTPUT_DIR = OUTPUT_DIR / "rasters"
SHAPE_OUTPUT_DIR = OUTPUT_DIR / "shapes"
SQL_DIR = BASE_DIR / "sql"

INPUT_RASTER = INPUT_DIR / "wc2.1_10m_elev.tif"
AOI_SHAPEFILE = DATA_DIR / "aoi_extent.shp"
# Archivos de salida intermedios/finales del pipeline.
CLIPPED_RASTER = RASTER_OUTPUT_DIR / "wc2.1_10m_elev_americas.tif"
DISCRETE_RASTER = RASTER_OUTPUT_DIR / "wc2.1_10m_elev_americas_bins.tif"
DISCRETE_SHP = SHAPE_OUTPUT_DIR / "wc2.1_10m_elev_americas_bins.shp"

# Metadatos que se guardan en catálogo de la DB.
SOURCE_CODE = "worldclim_dem_10m"
SOURCE_NAME = "WorldClim 2.1"
VARIABLE_NAME = "Elevation"
RESOLUTION = "10m"
UNITS = "meters"
AREA = "Americas"
DATASET_NAME = "WorldClim DEM Data Source"
DATASET_DESCRIPTION = "Fuente de elevación WorldClim 2.1 para América; incluye raster recortado, discretizado por bins y vectorizado para consulta espacial."
SOURCE_URL = "https://worldclim.org/data/worldclim21.html"
DOWNLOAD_URL = "https://worldclim.org/data/worldclim21.html"
DICT_URL = "https://worldclim.org/data/bioclim.html"
FILTER_FIELDS = '{"area":"string","bins":"integer","categoria":"string"}'
DEM_LABEL = "Shuttle Radar Topography Mission (SRTM)"
DEM_LAYER = "dem001"


def setup_logger() -> logging.Logger:
    # Logger único y simple para todo el script.
    logger = logging.getLogger("build_demdb")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
        logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger


def run_cmd(cmd: list[str], logger: logging.Logger) -> None:
    # Ejecuta comandos de sistema (GDAL/OGR) y aborta si fallan.
    logger.info("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(result.stderr.strip())
        raise RuntimeError(f"Command failed: {' '.join(cmd)}")
    if result.stdout.strip():
        logger.info(result.stdout.strip())


def load_sql(path: Path) -> str:
    # Lee script SQL completo desde archivo.
    return path.read_text(encoding="utf-8")


def ensure_paths() -> None:
    # Garantiza carpetas de salida para rasters y shapefiles.
    RASTER_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    SHAPE_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def clip_raster(logger: logging.Logger) -> None:
    # Recorta el raster global de elevación al AOI definido en shapefile.
    if not INPUT_RASTER.exists():
        raise FileNotFoundError(f"Input raster not found: {INPUT_RASTER}")
    if not AOI_SHAPEFILE.exists():
        raise FileNotFoundError(f"AOI shapefile not found: {AOI_SHAPEFILE}")

    run_cmd(
        [
            "gdalwarp",
            "-overwrite",
            "-cutline",
            str(AOI_SHAPEFILE),
            "-crop_to_cutline",
            "-dstnodata",
            "-9999",
            "-t_srs",
            "EPSG:4326",
            str(INPUT_RASTER),
            str(CLIPPED_RASTER),
        ],
        logger,
    )


def discretize_raster(nbins: int, logger: logging.Logger) -> list[tuple[int, float, float, str]]:
    # Obtiene min/max del raster recortado para generar intervalos equidistantes.
    gdalinfo = subprocess.run(
        ["gdalinfo", "-mm", str(CLIPPED_RASTER)],
        capture_output=True,
        text=True,
    )
    if gdalinfo.returncode != 0:
        raise RuntimeError(gdalinfo.stderr.strip())

    match = re.search(r"Computed Min/Max=([-0-9.]+),([-0-9.]+)", gdalinfo.stdout)
    if not match:
        raise RuntimeError("Could not parse min/max from gdalinfo output")

    min_val = float(match.group(1))
    max_val = float(match.group(2))
    step = (max_val - min_val) / nbins
    edges = [min_val + (step * i) for i in range(nbins + 1)]

    # bins_meta se usará para poblar dem_bins en PostgreSQL.
    bins_meta: list[tuple[int, float, float, str]] = []
    parts: list[str] = []
    for idx in range(nbins):
        low = float(edges[idx])
        high = float(edges[idx + 1])
        label = f"{low:.4f}:{high:.4f}"
        bins_meta.append((idx + 1, low, high, label))

        if idx < nbins - 1:
            parts.append(f"((A>={low})*(A<{high})*{idx+1})")
        else:
            parts.append(f"((A>={low})*(A<={high})*{idx+1})")

    # Expresión raster algebra: asigna clase [1..nbins], y 0 para nodata.
    calc_expr = f"((A==-9999)*0)+((A!=-9999)*({' + '.join(parts)}))"
    run_cmd(
        [
            "gdal_calc.py",
            "-A",
            str(CLIPPED_RASTER),
            f"--outfile={DISCRETE_RASTER}",
            f"--calc={calc_expr}",
            "--type=UInt16",
            "--NoDataValue=0",
            "--co=COMPRESS=LZW",
            "--overwrite",
        ],
        logger,
    )

    logger.info("Discretization complete: %s bins", nbins)
    return bins_meta


def polygonize_bins(logger: logging.Logger) -> None:
    # Limpia shapefile previo y vectoriza raster discreto (una clase por polígono).
    for ext in (".shp", ".dbf", ".shx", ".prj", ".cpg"):
        candidate = DISCRETE_SHP.with_suffix(ext)
        if candidate.exists():
            candidate.unlink()

    run_cmd(
        [
            "gdal_polygonize.py",
            str(DISCRETE_RASTER),
            "-b",
            "1",
            "-f",
            "ESRI Shapefile",
            str(DISCRETE_SHP),
            "dem_bin",
        ],
        logger,
    )


def get_db_conn():
    # Conexión PostgreSQL usando variables de entorno de dbbuild/.env.
    import psycopg2

    db_name = os.getenv("DBNICHENAME", "dem_db")
    db_host = os.getenv("DBNICHEHOST", "localhost")
    db_port = os.getenv("DBNICHEPORT", "5432")
    db_user = os.getenv("DBNICHEUSER", "postgres")
    db_pass = os.getenv("DBNICHEPASSWD", "postgres")

    return psycopg2.connect(
        dbname=db_name,
        host=db_host,
        port=db_port,
        user=db_user,
        password=db_pass,
    )


def init_db(logger: logging.Logger) -> None:
    # Crea extensión PostGIS y tablas base (dem_source_vars, dem_bins).
    init_sql = load_sql(SQL_DIR / "01_init_dem_db.sql")
    with get_db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(init_sql)
    logger.info("DB initialized")


def upsert_source_and_bins(nbins: int, bins_meta: list[tuple[int, float, float, str]], logger: logging.Logger) -> int:
    # Inserta/actualiza el registro de fuente DEM y refresca rangos de bins.
    from psycopg2.extras import execute_values

    upsert_data_source_sql = """
        INSERT INTO dem_data_source_info (
            name, description, source_url, download_url, dict_url
        ) VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (name)
        DO UPDATE SET
            description = EXCLUDED.description,
            source_url = EXCLUDED.source_url,
            download_url = EXCLUDED.download_url,
            dict_url = EXCLUDED.dict_url,
            updated_at = NOW()
        RETURNING id;
    """

    insert_source_sql = """
        INSERT INTO dem_source_vars (
            data_source_id, source_code, fuente, area, bins, descripcion, level_size, available_grids, filter_fields,
            source_name, variable_name, resolution, units, bins_count, raster_file
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, ARRAY[]::INTEGER[], %s::jsonb, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (source_code, area, bins)
        DO UPDATE SET
            data_source_id = EXCLUDED.data_source_id,
            fuente = EXCLUDED.fuente,
            descripcion = EXCLUDED.descripcion,
            level_size = EXCLUDED.level_size,
            available_grids = EXCLUDED.available_grids,
            filter_fields = EXCLUDED.filter_fields,
            source_name = EXCLUDED.source_name,
            variable_name = EXCLUDED.variable_name,
            resolution = EXCLUDED.resolution,
            units = EXCLUDED.units,
            bins_count = EXCLUDED.bins_count,
            raster_file = EXCLUDED.raster_file,
            updated_at = NOW()
        RETURNING id;
    """

    with get_db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                upsert_data_source_sql,
                (
                    DATASET_NAME,
                    DATASET_DESCRIPTION,
                    SOURCE_URL,
                    DOWNLOAD_URL,
                    DICT_URL,
                ),
            )
            data_source_id = cur.fetchone()[0]

            cur.execute(
                insert_source_sql,
                (
                    data_source_id,
                    SOURCE_CODE,
                    "worldclim Historical climate data",
                    AREA,
                    nbins,
                    "worldclim 10min",
                    len(bins_meta),
                    FILTER_FIELDS,
                    SOURCE_NAME,
                    VARIABLE_NAME,
                    RESOLUTION,
                    UNITS,
                    nbins,
                    INPUT_RASTER.name,
                ),
            )
            source_var_id = cur.fetchone()[0]

            # Se reinsertan bins para mantener consistencia si cambia nbins.
            cur.execute("DELETE FROM dem_bins WHERE source_var_id = %s", (source_var_id,))
            execute_values(
                cur,
                """
                INSERT INTO dem_bins (source_var_id, bin_index, tag, layer, min_value, max_value, label)
                VALUES %s
                """,
                [
                    (
                        source_var_id,
                        b_idx,
                        b_tag,
                        DEM_LAYER,
                        b_min,
                        b_max,
                        DEM_LABEL,
                    )
                    for b_idx, b_min, b_max, b_tag in bins_meta
                ],
            )

    logger.info("Inserted source metadata and %s bins", len(bins_meta))
    return source_var_id


def load_polygons_to_postgis(nbins: int, source_var_id: int, logger: logging.Logger) -> str:
    # Carga shapefile de bins como tabla PostGIS (dem_elev_q{nbins}).
    table_name = f"dem_elev_q{nbins}"

    db_name = os.getenv("DBNICHENAME", "dem_db")
    db_host = os.getenv("DBNICHEHOST", "localhost")
    db_port = os.getenv("DBNICHEPORT", "5432")
    db_user = os.getenv("DBNICHEUSER", "postgres")
    db_pass = os.getenv("DBNICHEPASSWD", "postgres")

    run_cmd(
        [
            "ogr2ogr",
            "-f",
            "PostgreSQL",
            f"PG:dbname={db_name} host={db_host} port={db_port} user={db_user} password={db_pass}",
            str(DISCRETE_SHP),
            "-nln",
            table_name,
            "-overwrite",
            "-lco",
            "GEOMETRY_NAME=the_geom",
            "-lco",
            "FID=id",
            "-nlt",
            "MULTIPOLYGON",
        ],
        logger,
    )

    # Enriquece tabla espacial con metadatos y crea índices para consulta.
    with get_db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = %s
                  AND lower(column_name) IN ('dem_bin', 'dn')
                ORDER BY CASE WHEN lower(column_name) = 'dem_bin' THEN 0 ELSE 1 END
                LIMIT 1;
                """,
                (table_name,),
            )
            row = cur.fetchone()
            if not row:
                raise RuntimeError(f"Could not find bin column (dem_bin or DN) in table {table_name}")
            bin_col = row[0]

            cur.execute(
                f"""
                ALTER TABLE {table_name}
                ADD COLUMN IF NOT EXISTS source_code TEXT,
                ADD COLUMN IF NOT EXISTS source_var_id INTEGER,
                ADD COLUMN IF NOT EXISTS bin_index INTEGER,
                ADD COLUMN IF NOT EXISTS bin_label TEXT,
                ADD COLUMN IF NOT EXISTS min_value DOUBLE PRECISION,
                ADD COLUMN IF NOT EXISTS max_value DOUBLE PRECISION;
                """
            )
            cur.execute(
                f"""
                UPDATE {table_name} p
                SET
                    source_code = %s,
                    source_var_id = %s,
                    bin_index = p.{bin_col},
                    bin_label = b.tag,
                    min_value = b.min_value,
                    max_value = b.max_value
                FROM dem_bins b
                WHERE b.source_var_id = %s
                  AND b.bin_index = p.{bin_col};
                """,
                (SOURCE_CODE, source_var_id, source_var_id),
            )
            cur.execute(f"DELETE FROM {table_name} WHERE {bin_col} = 0")
            cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{table_name}_geom ON {table_name} USING GIST (the_geom)")
            cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{table_name}_bin ON {table_name} (bin_index)")

    logger.info("Polygons loaded in table: %s", table_name)
    return table_name


def parse_args() -> argparse.Namespace:
    # Parámetros CLI: número de bins y modo validación.
    parser = argparse.ArgumentParser(description="Build DEM database from WorldClim elevation raster")
    parser.add_argument("--nbins", type=int, default=10, help="Number of bins for discretization")
    parser.add_argument("--dry-run", action="store_true", help="Validate configuration and exit")
    return parser.parse_args()


def main() -> int:
    # Orquestador principal del pipeline.
    logger = setup_logger()
    try:
        from dotenv import load_dotenv
    except ImportError as exc:
        logger.error("python-dotenv is required. Activate your virtualenv first.")
        return 1

    load_dotenv(BASE_DIR / ".env")
    args = parse_args()

    if args.nbins < 2:
        logger.error("--nbins must be >= 2")
        return 1

    ensure_paths()

    # Validación de prerequisitos sin ejecutar procesamiento pesado.
    if args.dry_run:
        logger.info("Dry run OK")
        logger.info("Input raster: %s", INPUT_RASTER)
        logger.info("AOI shapefile: %s", AOI_SHAPEFILE)
        return 0

    # Pipeline completo ETL DEM.
    clip_raster(logger)
    bins_meta = discretize_raster(args.nbins, logger)
    polygonize_bins(logger)
    init_db(logger)
    source_var_id = upsert_source_and_bins(args.nbins, bins_meta, logger)
    load_polygons_to_postgis(args.nbins, source_var_id, logger)

    logger.info("DEM build completed successfully")
    return 0


if __name__ == "__main__":
    sys.exit(main())
