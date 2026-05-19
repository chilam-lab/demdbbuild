CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS dem_data_source_info (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL UNIQUE,
    description TEXT,
    source_url TEXT,
    download_url TEXT,
    dict_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dem_source_vars (
    id SERIAL PRIMARY KEY,
    data_source_id INTEGER NOT NULL REFERENCES dem_data_source_info(id) ON DELETE RESTRICT,
    source_code TEXT NOT NULL,
    fuente TEXT NOT NULL,
    area TEXT NOT NULL,
    bins INTEGER NOT NULL,
    descripcion TEXT NOT NULL,
    level_size INTEGER,
    available_grids INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    filter_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_name TEXT NOT NULL,
    variable_name TEXT NOT NULL,
    resolution TEXT NOT NULL,
    units TEXT,
    bins_count INTEGER NOT NULL,
    raster_file TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_code, area, bins)
);

CREATE TABLE IF NOT EXISTS dem_bins (
    id BIGSERIAL PRIMARY KEY,
    source_var_id INTEGER NOT NULL REFERENCES dem_source_vars(id) ON DELETE CASCADE,
    bin_index INTEGER NOT NULL,
    tag TEXT NOT NULL,
    layer TEXT NOT NULL,
    min_value DOUBLE PRECISION NOT NULL,
    max_value DOUBLE PRECISION NOT NULL,
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_var_id, bin_index)
);

-- Mantiene convención de IDs de catálogo tipo WorldClim (300000+).
ALTER SEQUENCE IF EXISTS dem_bins_id_seq RESTART WITH 300000;

CREATE INDEX IF NOT EXISTS idx_dem_bins_source_var_id ON dem_bins (source_var_id);
CREATE INDEX IF NOT EXISTS idx_dem_source_vars_data_source_id ON dem_source_vars (data_source_id);
