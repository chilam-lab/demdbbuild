# DEM DB Build

Construcción de base de datos geoespacial para elevación (WorldClim 2.1) enfocada en América.

Este módulo genera y carga en PostGIS:
- catálogo de fuente y configuraciones por bins,
- catálogo de rangos (`dem_bins`),
- capas vectoriales por discretización (`dem_elev_q{nbins}`),
- metadatos de cobertura por mallas (`available_grids`) usando `meshandregions_db`.

## Objetivo

Automatizar un pipeline ETL para DEM:
1. recorte del raster de elevación al AOI (Américas),
2. discretización en `N` bins,
3. vectorización por bin,
4. carga a PostGIS,
5. cálculo de `available_grids` por cruce espacial con mallas/regiones.

## Estructura

```text
dbbuild/
├── build_demdb.py                  # Script principal ETL DEM
├── .env                            # Variables de conexión (dem_db y meshandregions_db)
├── data/
│   ├── input/
│   │   └── wc2.1_10m_elev.tif      # Raster DEM de entrada
│   ├── output/
│   │   ├── rasters/                # Salidas raster intermedias/finales
│   │   └── shapes/                 # Salidas shapefile intermedias/finales
│   └── aoi_extent.shp              # AOI para recorte
└── sql/
    ├── 01_init_dem_db.sql          # Esquema base (tablas DEM)
    ├── 02_create_mesh_fdw.sql      # FDW a meshandregions_db
    └── 03_update_available_grids.sql # Cálculo de available_grids
```

## Tablas principales

- `dem_data_source_info`: metadatos de la fuente de datos.
- `dem_source_vars`: configuración por fuente/área/bins (`level_size`, `available_grids`, `filter_fields`).
- `dem_bins`: rangos por bin (`tag`, `layer`, `label`, `min_value`, `max_value`).
- `dem_elev_q10`, `dem_elev_q20`, ...: capas espaciales resultantes por discretización.

## Prerrequisitos

- Python 3
- GDAL CLI disponible en PATH:
  - `gdalwarp`
  - `gdal_calc.py`
  - `gdal_polygonize.py`
  - `ogr2ogr`
- PostgreSQL + PostGIS accesible
- Credenciales en `.env`

Variables requeridas en `.env`:

```env
DBNICHENAME=
DBNICHEHOST=
DBNICHEPORT=
DBNICHEUSER=
DBNICHEPASSWD=

DBMESHNAME=
DBMESHHOST=
DBMESHPORT=
DBMESHUSER=
DBMESHPASSWD=
```

## Ejecución

Desde la carpeta `dbbuild`:

```bash
python3 build_demdb.py --dry-run
python3 build_demdb.py --nbins 10
python3 build_demdb.py --nbins 20
```

Comportamiento esperado:
- `--nbins 10` crea/actualiza `dem_elev_q10`.
- `--nbins 20` crea/actualiza `dem_elev_q20`.
- ambas configuraciones coexisten en `dem_source_vars` (clave única por `source_code + area + bins`).

## Validación rápida SQL

```sql
-- fuentes por bins
select id, source_code, area, bins, level_size, array_length(available_grids, 1) as n_grids
from dem_source_vars
order by bins;

-- bins por configuración
select s.bins, count(*) as n_bins
from dem_bins b
join dem_source_vars s on s.id = b.source_var_id
group by s.bins
order by s.bins;

-- capas espaciales
select count(*) from dem_elev_q10;
select count(*) from dem_elev_q20;

-- muestra de atributos espaciales
select id, bin_index, min_value, max_value, value
from dem_elev_q10
limit 20;
```

## Notas operativas

- El script ejecuta `01_init_dem_db.sql` en cada corrida (idempotente).
- `available_grids` se calcula al final usando FDW (`02_create_mesh_fdw.sql` + `03_update_available_grids.sql`).
- `value` en `dem_elev_q{nbins}` se calcula como punto medio del rango: `(min_value + max_value) / 2.0`.
- Si corres de nuevo con el mismo `nbins`, se sobreescribe solo la tabla espacial `dem_elev_q{nbins}`.

## Alcance actual

Este módulo cubre únicamente la construcción y carga de base de datos DEM.

La capa de servicios/middleware se integrará en una fase posterior del proyecto.

## middleware_dem

`middleware_dem` expone la información construida por `dbbuild` bajo un contrato compatible con SPECIES v3, usando el prefijo de rutas `demv3`.

### Estructura relevante

```text
middleware_dem/
├── .env.example
├── config.js
├── package.json
└── src/
    ├── server.js
    ├── routes/
    │   └── demv3router.js
    └── controllers/
        ├── demv3_controller.js
        └── verb_utils.js
```

### Variables de entorno (`middleware_dem/.env`)

```env
PORT=

DBNAME=
DBUSER=
DBPWD=
DBHOST=
DBPORT=

DBNAME_MALLAS=
DBUSER_MALLAS=
DBPWD_MALLAS=
DBHOST_MALLAS=
DBPORT_MALLAS=
```

### Ejecución

```bash
cd middleware_dem
npm install
npm run dev
```

### Endpoints base

- `GET/POST /demv3/`
- `GET/POST /demv3/db-health`
- `GET/POST /demv3/variables`
- `GET/POST /demv3/variables/:id`
- `GET/POST /demv3/get-data/:id`
- `GET/POST /demv3/info`
