var debug = require('debug')('verbs:controllers');
var verb_utils = require('./verb_utils');
var pgp = require('pg-promise')();

var pool = verb_utils.pool;
var pool_mallas = verb_utils.pool_mallas;

var valid_filters = ['levels_id', 'categoria', 'tag', 'layer'];
var MAX_LIMIT = 500;
var MAX_LEVELS = 500;
var GEOM_CHUNK_SIZE = 500;

const gridResolutionCache = new Map(); // grid_id → { cellColumn, resolvedTable }
const demVarCache = new Map();          // variable_id → { bins, demTableName }
const resultCache = new Map();          // cacheKey → { data, ts }
const RESULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

function buildResultCacheKey(variable_id, grid_id, levels_id, filter_names, filter_values) {
  const lvls = levels_id.slice().sort((a, b) => a - b).join(',');
  const filters = filter_names.map((n, i) => `${n}=${filter_values[i]}`).join(';');
  return `${variable_id}:${grid_id}:${lvls}:${filters}`;
}

async function resolveGridTableName(poolMallas, tableCellName) {
  const candidate = String(tableCellName || '').trim().toLowerCase();
  if (!candidate) return null;

  const reg = await poolMallas.oneOrNone('SELECT to_regclass($1) AS reg', [`public.${candidate}`]);
  if (reg && reg.reg) return candidate;

  const fallbackMap = {
    grid_64km_aoi: 'grid_geojson_64km_aoi',
    grid_32km_aoi: 'grid_geojson_32km_aoi',
    grid_16km_aoi: 'grid_geojson_16km_aoi',
    grid_8km_aoi: 'grid_geojson_8km_aoi',
    grid_state_aoi: 'grid_geojson_state_aoi',
    grid_mun_aoi: 'grid_geojson_mun_aoi',
    grid_ageb_aoi: 'grid_geojson_ageb_aoi',
    grid_cue_aoi: 'grid_geojson_cue_aoi',
  };

  const fallback = fallbackMap[candidate];
  if (!fallback) return null;

  const regFallback = await poolMallas.oneOrNone('SELECT to_regclass($1) AS reg', [`public.${fallback}`]);
  if (regFallback && regFallback.reg) return fallback;

  // fallback adicional por nombres inconsistentes detectados en algunos catálogos
  const normalizedRes = candidate
    .replace(/^grid_/, '')
    .replace(/^gri_d/, '')
    .replace(/_aoi$/, '');
  const extraCandidates = [
    `grid_${normalizedRes}_aoi`,
    `grid_geojson_${normalizedRes}_aoi`,
    `gri_d${normalizedRes}_aoi`,
  ];

  for (const tbl of extraCandidates) {
    const regExtra = await poolMallas.oneOrNone('SELECT to_regclass($1) AS reg', [`public.${tbl}`]);
    if (regExtra && regExtra.reg) return tbl;
  }

  return null;
}

const ALLOWED_CELL_TABLES = [
  'grid_64km_aoi',
  'grid_32km_aoi',
  'grid_16km_aoi',
  'grid_8km_aoi',
  'grid_state_aoi',
  'grid_mun_aoi',
  'grid_ageb_aoi',
  'grid_cue_aoi'
];

async function getDemVar(variable_id) {
  if (demVarCache.has(variable_id)) return demVarCache.get(variable_id);

  const variableRow = await pool.oneOrNone(
    'SELECT id, bins FROM dem_source_vars WHERE id = $1',
    [variable_id]
  );
  if (!variableRow) return null;

  const demTableName = `dem_elev_q${variableRow.bins}`;
  const tableReg = await pool.oneOrNone('SELECT to_regclass($1) AS reg', [`public.${demTableName}`]);
  if (!tableReg || !tableReg.reg) return null;

  const result = { bins: variableRow.bins, demTableName };
  demVarCache.set(variable_id, result);
  return result;
}

async function getGridResolution(grid_id) {
  if (gridResolutionCache.has(grid_id)) return gridResolutionCache.get(grid_id);

  const gridInfo = await pool_mallas.oneOrNone(
    'SELECT resolution, table_cell_name, table_view_name, region_id FROM cat_grid WHERE grid_id = $1',
    [grid_id]
  );
  if (!gridInfo) return null;

  const tableCellName = String(gridInfo.table_cell_name || '').trim();
  const cellColumn = `gridid_${String(gridInfo.resolution).toLowerCase()}`;

  if (!ALLOWED_CELL_TABLES.includes(tableCellName)) return null;

  const resolvedTable = await resolveGridTableName(pool_mallas, tableCellName);
  if (!resolvedTable) return null;

  const colExists = await pool_mallas.oneOrNone(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [resolvedTable, cellColumn]
  );
  if (!colExists) return null;

  const tableViewName = String(gridInfo.table_view_name || '').trim();
  const region_id     = gridInfo.region_id || null;

  const result = { cellColumn, resolvedTable, tableViewName, region_id };
  gridResolutionCache.set(grid_id, result);
  return result;
}

exports.variables = async function (req, res) {
  try {
    const data = await pool.any(
      `SELECT
         id,
         (lower(variable_name) || '_q' || bins::text) AS variable,
         level_size,
         filter_fields,
         available_grids
       FROM dem_source_vars
       ORDER BY id;`,
      {}
    );

    return res.status(200).json({ data });
  } catch (error) {
    debug(error);
    return res.status(500).json({
      message: 'Error interno al obtener el catálogo de variables DEM'
    });
  }
};

exports.get_variable_byid = async function (req, res) {
  try {
    const variable_id = Number(req.params.id);
    const q = verb_utils.getParam(req, 'q', '');
    const offset = Number(verb_utils.getParam(req, 'offset', 0));
    const limit = Number(verb_utils.getParam(req, 'limit', 10));

    if (!Number.isInteger(variable_id) || variable_id <= 0) {
      return res.status(400).json({ message: 'El parámetro id es inválido' });
    }

    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      return res.status(400).json({ message: 'Parámetros offset/limit inválidos' });
    }

    const variableRow = await pool.oneOrNone(
      'SELECT id FROM dem_source_vars WHERE id = $1',
      [variable_id]
    );

    if (!variableRow) {
      return res.status(404).json({ message: 'No existe la variable solicitada' });
    }

    const conditions = ['b.source_var_id = $1'];
    const values = [variable_id];
    let paramIdx = 2;

    if (q !== '') {
      const filter_separator = ';';
      const pair_separator = '=';
      const group_separator = ',';

      const array_queries = q.split(filter_separator).map(x => x.trim()).filter(Boolean);

      for (const filter of array_queries) {
        const filter_pair = filter.split(pair_separator);
        if (filter_pair.length !== 2) {
          return res.status(400).json({ message: `Filtro inválido por composición: ${filter}` });
        }

        const filter_param = filter_pair[0].trim();
        if (valid_filters.indexOf(filter_param) === -1) {
          return res.status(400).json({ message: `Filtro inválido: ${filter_param}` });
        }

        const filter_values = filter_pair[1].trim().split(group_separator).map(v => v.trim()).filter(Boolean);
        if (filter_values.length === 0) {
          return res.status(400).json({ message: `Filtro sin valores: ${filter_param}` });
        }

        if (filter_param === 'levels_id') {
          const ids = filter_values.map(Number).filter(n => Number.isInteger(n) && n > 0);
          if (ids.length === 0) {
            return res.status(400).json({ message: 'levels_id no contiene valores válidos' });
          }
          conditions.push(`b.id IN ($${paramIdx}:csv)`);
          values.push(ids);
          paramIdx += 1;
          continue;
        }

        if (filter_param === 'categoria' || filter_param === 'layer') {
          conditions.push(`lower(b.layer) IN ($${paramIdx}:csv)`);
          values.push(filter_values.map(v => String(v).toLowerCase()));
          paramIdx += 1;
          continue;
        }

        if (filter_param === 'tag') {
          conditions.push(`b.tag IN ($${paramIdx}:csv)`);
          values.push(filter_values);
          paramIdx += 1;
        }
      }
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT
        s.id AS id,
        b.id AS level_id,
        jsonb_build_object(
          'categoria', b.layer,
          'tag', b.tag,
          'label', b.label,
          'bin_index', b.bin_index,
          'min_value', b.min_value,
          'max_value', b.max_value,
          'value', (b.min_value + b.max_value) / 2.0
        ) AS datos
      FROM dem_bins b
      JOIN dem_source_vars s ON s.id = b.source_var_id
      ${whereSql}
      ORDER BY b.bin_index
      OFFSET ${offset}
      LIMIT ${limit};
    `;

    const data = await pool.any(query, values);
    return res.status(200).json({ data });
  } catch (error) {
    debug(error);
    return res.status(500).json({
      message: 'Error interno al obtener niveles de la variable DEM'
    });
  }
};

exports.get_data_byid = async function (req, res) {
  try {
    const variable_id = Number(req.params.id);
    const grid_id = Number(verb_utils.getParam(req, 'grid_id', 1));
    const levels_id_raw = verb_utils.getParam(req, 'levels_id', []);
    const filter_names = verb_utils.getParam(req, 'filter_names', []);
    const filter_values = verb_utils.getParam(req, 'filter_values', []);

    if (!Number.isInteger(variable_id) || variable_id <= 0) {
      return res.status(400).json({ message: 'El parámetro id es inválido' });
    }

    if (!Number.isInteger(grid_id) || grid_id <= 0) {
      return res.status(400).json({ message: 'El parámetro grid_id es inválido' });
    }

    const levels_id_arr = Array.isArray(levels_id_raw) ? levels_id_raw : [levels_id_raw];
    const levels_id = levels_id_arr.map(Number).filter((n) => Number.isInteger(n) && n > 0);

    if (levels_id.length === 0) {
      return res.status(400).json({ message: 'levels_id debe ser un arreglo con al menos un valor válido' });
    }
    if (levels_id.length > MAX_LEVELS) {
      return res.status(400).json({ message: `levels_id excede el máximo permitido (${MAX_LEVELS})` });
    }

    if (!Array.isArray(filter_names) || !Array.isArray(filter_values) || filter_names.length !== filter_values.length) {
      return res.status(400).json({ message: 'filter_names y filter_values deben ser arreglos del mismo tamaño' });
    }
    if (!filter_names.every((f) => typeof f === 'string')) {
      return res.status(400).json({ message: 'filter_names debe contener solo strings' });
    }

    const cacheKey = buildResultCacheKey(variable_id, grid_id, levels_id, filter_names, filter_values);
    const cached = resultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL_MS) {
      return res.status(200).json(cached.data);
    }

    // Resolución en paralelo — ambas funciones tienen caché interno
    const [demVar, gridRes] = await Promise.all([
      getDemVar(variable_id),
      getGridResolution(grid_id)
    ]);

    if (!demVar) {
      return res.status(404).json({ message: 'No existe la variable solicitada o su tabla espacial' });
    }
    if (!gridRes) {
      return res.status(404).json({ message: 'No existe la malla solicitada o su configuración es inválida' });
    }

    const { demTableName } = demVar;
    const { cellColumn, resolvedTable: resolvedCellTable, tableViewName, region_id } = gridRes;

    const conditionParts = ['d.source_var_id = $1', 'b.id IN ($2:csv)'];
    const values = [variable_id, levels_id];
    let paramIdx = 3;

    for (let i = 0; i < filter_names.length; i++) {
      const filterParam = filter_names[i];
      const filterValue = filter_values[i];

      if (filterParam === 'categoria') {
        conditionParts.push(`lower(b.layer) = lower($${paramIdx})`);
        values.push(String(filterValue));
        paramIdx += 1;
      } else if (filterParam === 'tag') {
        conditionParts.push(`b.tag = $${paramIdx}`);
        values.push(String(filterValue));
        paramIdx += 1;
      } else if (filterParam === 'min_value') {
        const num = Number(filterValue);
        if (!Number.isFinite(num)) {
          return res.status(400).json({ message: 'min_value debe ser numérico' });
        }
        conditionParts.push(`b.min_value >= $${paramIdx}`);
        values.push(num);
        paramIdx += 1;
      } else if (filterParam === 'max_value') {
        const num = Number(filterValue);
        if (!Number.isFinite(num)) {
          return res.status(400).json({ message: 'max_value debe ser numérico' });
        }
        conditionParts.push(`b.max_value <= $${paramIdx}`);
        values.push(num);
        paramIdx += 1;
      } else {
        return res.status(400).json({ message: `Filtro no válido: ${filterParam}` });
      }
    }

    const whereSql = `WHERE ${conditionParts.join(' AND ')}`;

    const query = `
      WITH numbered AS (
        SELECT
          d.the_geom,
          b.id AS bid,
          b.layer, b.tag, b.label, b.bin_index, b.min_value, b.max_value,
          floor((row_number() OVER (PARTITION BY b.id ORDER BY d.id) - 1) / ${GEOM_CHUNK_SIZE}) AS chunk_idx
        FROM ${pgp.as.name(demTableName)} d
        JOIN dem_bins b
          ON b.source_var_id = d.source_var_id
         AND b.bin_index = d.bin_index
        ${whereSql}
      )
      SELECT
        $1::int AS id,
        bid AS level_id,
        chunk_idx,
        jsonb_build_object(
          'categoria', layer,
          'tag', tag,
          'label', label,
          'bin_index', bin_index,
          'min_value', min_value,
          'max_value', max_value,
          'value', (min_value + max_value) / 2.0
        ) AS metadata,
        ST_AsText(ST_Collect(the_geom)) AS geom_chunk
      FROM numbered
      GROUP BY bid, layer, tag, label, bin_index, min_value, max_value, chunk_idx
      ORDER BY bin_index, chunk_idx;
    `;

    const data = await pool.any(query, values);
    if (!data || data.length === 0) {
      return res.status(200).json([]);
    }

    // Recorta las celdas a la región del grid (ej. México) antes de intersectar
    // con la geometría del bin DEM, evitando que nj supere el total n de la región.
    const meshQuery = (tableViewName && region_id)
      ? `
        WITH regionarea AS (
          SELECT g.${pgp.as.name(cellColumn)} AS cell, g.the_geom
          FROM ${pgp.as.name(resolvedCellTable)} g
          JOIN ${pgp.as.name(tableViewName)} vg ON ST_Intersects(g.the_geom, vg.border)
          WHERE vg.region_id = ${region_id}
        )
        SELECT DISTINCT ra.cell
        FROM (SELECT ST_Subdivide(ST_GeomFromText($1, 4326), 64) AS geom) sub
        JOIN regionarea ra ON ST_Intersects(ra.the_geom, sub.geom)
        ORDER BY cell;
      `
      : `
        SELECT DISTINCT g.${pgp.as.name(cellColumn)} AS cell
        FROM (SELECT ST_Subdivide(ST_GeomFromText($1, 4326), 64) AS geom) sub
        JOIN ${pgp.as.name(resolvedCellTable)} g ON ST_Intersects(g.the_geom, sub.geom)
        ORDER BY cell;
      `;

    // Agrupar chunks por level_id
    const levelMap = new Map();
    for (const row of data) {
      if (!levelMap.has(row.level_id)) {
        levelMap.set(row.level_id, { id: row.id, level_id: row.level_id, metadata: row.metadata, geomChunks: [] });
      }
      if (row.geom_chunk) {
        levelMap.get(row.level_id).geomChunks.push(row.geom_chunk);
      }
    }

    // Por cada bin: todos sus chunks en paralelo → deduplicar celdas
    const responseArray = await Promise.all(
      Array.from(levelMap.values()).map(async ({ id, level_id, metadata, geomChunks }) => {
        if (geomChunks.length === 0) {
          return { id, grid_id, level_id, metadata, cells: [], n: 0 };
        }
        const chunkResults = await Promise.all(
          geomChunks.map((chunk) => pool_mallas.any(meshQuery, [chunk]))
        );
        const cellSet = new Set();
        for (const rows of chunkResults) {
          for (const r of rows) cellSet.add(r.cell);
        }
        const cells = Array.from(cellSet).sort((a, b) => (a < b ? -1 : 1));
        return { id, grid_id, level_id, metadata, cells, n: cells.length };
      })
    );

    resultCache.set(cacheKey, { data: responseArray, ts: Date.now() });
    return res.status(200).json(responseArray);
  } catch (error) {
    debug(error);
    return res.status(500).json({
      message: 'Error interno al obtener datos DEM'
    });
  }
};

exports.get_sourceinfo = async function (req, res) {
  try {
    const data = await pool.oneOrNone(
      `SELECT
         name,
         description,
         source_url,
         download_url,
         dict_url
       FROM dem_data_source_info
       ORDER BY updated_at DESC, id DESC
       LIMIT 1;`,
      {}
    );

    if (!data) {
      return res.status(404).json({
        message: 'No se encontró información de la fuente de datos DEM'
      });
    }

    return res.status(200).json({ data });
  } catch (error) {
    debug(error);
    return res.status(500).json({
      message: 'Error interno al obtener información de la fuente DEM'
    });
  }
};

exports.secuencia = async function (req, res) {
  return res.status(501).json({ message: 'No aplica para DEM en esta fase' });
};
