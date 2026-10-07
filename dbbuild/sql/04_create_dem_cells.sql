-- Celdas precalculadas por rango de elevación (dem_bins.id) y malla
-- (cat_grid.grid_id). La llena precompute_dem_cells.py; el middleware
-- (get-data) la lee antes de calcular en vivo. Mismo resultado que el cálculo
-- en vivo: celdas de la región del grid_id que intersectan los polígonos del rango.
CREATE TABLE IF NOT EXISTS dem_cells (
  bid        integer NOT NULL,
  grid_id    integer NOT NULL,
  cells      integer[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bid, grid_id)
);
