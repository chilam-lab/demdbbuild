var debug = require('debug')('verbs:controllers');
var verb_utils = require('./verb_utils');
var pgp = require('pg-promise')();

var pool = verb_utils.pool;
var pool_mallas = verb_utils.pool_mallas;

var valid_filters = ['levels_id', 'categoria', 'tag', 'layer'];
var MAX_LIMIT = 500;
var MAX_LEVELS = 500;

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

    const levels_id = Array.isArray(levels_id_raw)
      ? levels_id_raw.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];

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

    const variableRow = await pool.oneOrNone(
      'SELECT id, bins FROM dem_source_vars WHERE id = $1',
      [variable_id]
    );

    if (!variableRow) {
      return res.status(404).json({ message: 'No existe la variable solicitada' });
    }

    const demTableName = `dem_elev_q${variableRow.bins}`;
    const demTableReg = await pool.oneOrNone('SELECT to_regclass($1) AS reg', [`public.${demTableName}`]);
    if (!demTableReg || !demTableReg.reg) {
      return res.status(500).json({ message: `No existe la tabla espacial esperada: ${demTableName}` });
    }

    const gridInfo = await pool_mallas.oneOrNone(
      'SELECT resolution, table_cell_name FROM cat_grid WHERE grid_id = $1',
      [grid_id]
    );

    if (!gridInfo) {
      return res.status(404).json({ message: 'No existe la malla solicitada (grid_id)' });
    }

    const cellColumn = `gridid_${String(gridInfo.resolution).toLowerCase()}`;
    const tableCellName = String(gridInfo.table_cell_name || '').trim();

    const allowedCellTables = [
      'grid_64km_aoi',
      'grid_32km_aoi',
      'grid_16km_aoi',
      'grid_8km_aoi',
      'grid_state_aoi',
      'grid_mun_aoi',
      'grid_ageb_aoi',
      'grid_cue_aoi'
    ];

    if (!allowedCellTables.includes(tableCellName)) {
      return res.status(400).json({ message: `table_cell_name no permitido: ${tableCellName}` });
    }

    const resolvedCellTable = await resolveGridTableName(pool_mallas, tableCellName);
    if (!resolvedCellTable) {
      return res.status(500).json({
        message: `No se encontró tabla de celdas para grid_id=${grid_id} (table_cell_name=${tableCellName})`
      });
    }

    const cellColumnExists = await pool_mallas.oneOrNone(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2`,
      [resolvedCellTable, cellColumn]
    );
    if (!cellColumnExists) {
      return res.status(500).json({
        message: `La columna de celda ${cellColumn} no existe en ${resolvedCellTable}`
      });
    }

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
      SELECT
        $1::int AS id,
        b.id AS level_id,
        jsonb_build_object(
          'categoria', b.layer,
          'tag', b.tag,
          'label', b.label,
          'bin_index', b.bin_index,
          'min_value', b.min_value,
          'max_value', b.max_value,
          'value', (b.min_value + b.max_value) / 2.0
        ) AS metadata,
        array_agg(ST_AsText(d.the_geom)) AS geoms
      FROM ${pgp.as.name(demTableName)} d
      JOIN dem_bins b
        ON b.source_var_id = d.source_var_id
       AND b.bin_index = d.bin_index
      ${whereSql}
      GROUP BY b.id, b.layer, b.tag, b.label, b.bin_index, b.min_value, b.max_value
      ORDER BY b.bin_index;
    `;

    const data = await pool.any(query, values);
    if (!data || data.length === 0) {
      return res.status(200).json([]);
    }

    const responseArray = [];
    for (const row of data) {
      const geoms = Array.isArray(row.geoms) ? row.geoms.filter(Boolean) : [];
      if (geoms.length === 0) {
        responseArray.push({
          id: row.id,
          grid_id: grid_id,
          level_id: row.level_id,
          metadata: row.metadata,
          cells: [],
          n: 0,
        });
        continue;
      }

      const queryPoints = geoms
        .map((wkt) => `ST_SetSRID(ST_GeomFromText('${String(wkt).replace(/'/g, "''")}'), 4326)`)
        .join(', ');

      const meshQuery = `
        WITH dem_geom AS (
          SELECT unnest(ARRAY[${queryPoints}]) AS geom
        )
        SELECT DISTINCT g.${pgp.as.name(cellColumn)} AS cell
        FROM dem_geom d
        JOIN ${pgp.as.name(resolvedCellTable)} g
          ON g.the_geom IS NOT NULL
         AND d.geom IS NOT NULL
         AND g.the_geom && d.geom
         AND ST_Intersects(g.the_geom, d.geom)
        ORDER BY cell;
      `;

      const meshRows = await pool_mallas.any(meshQuery, {});
      const cells = meshRows.map((r) => r.cell);

      responseArray.push({
        id: row.id,
        grid_id: grid_id,
        level_id: row.level_id,
        metadata: row.metadata,
        cells,
        n: cells.length,
      });
    }

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
