# middleware_dem

Middleware DEM para exponer servicios compatibles con la especificación SPECIES v3.

## Estado

Fase 1 completada:
- estructura base del servicio,
- configuración de conexiones a DB DEM y DB de mallas,
- ruteo base `/demv3`,
- endpoints del estándar creados (por ahora con respuesta `501` excepto `db-health`).

## Endpoints base

- `GET/POST /demv3/variables`
- `GET/POST /demv3/variables/:id`
- `GET/POST /demv3/get-data/:id`
- `GET/POST /demv3/info`
- `GET/POST /demv3/secuencia` (placeholder; no prioritario para DEM)
- `GET/POST /demv3/db-health`

## Variables de entorno

Copia `.env.example` a `.env` y define credenciales.

## Ejecución

```bash
npm install
npm run dev
```

Servicio disponible en `http://localhost:8080/demv3`.
