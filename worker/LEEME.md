# Worker de noticias — Noticias_pty

Lee los RSS de los medios, los clasifica en las 8 categorías de la app y entrega un JSON listo. Guarda el resultado 10 minutos en caché. No necesita KV, cron ni variables.

## Desplegar desde el teléfono (panel de Cloudflare)

1. Entra a dash.cloudflare.com → **Workers y Pages** → **Crear** → **Crear Worker**.
2. Nómbralo `noticias-pty-api` → **Implementar**.
3. **Editar código** → borra todo → pega el contenido de `worker.js` → **Implementar**.
4. Abre `https://noticias-pty-api.TU-USUARIO.workers.dev/estado` y revisa qué fuentes salen con `"ok": true`.
5. En `app.js` de la PWA, pega la URL en `URL_API`:
   ```js
   const URL_API = 'https://noticias-pty-api.TU-USUARIO.workers.dev/noticias';
   ```

## Rutas

| Ruta | Qué devuelve |
|---|---|
| `/noticias` (o `/`) | Lista de noticias para la app |
| `/estado` | Fuentes que funcionaron, cuántas noticias trajo cada una y el conteo por categoría |
| `?refrescar=1` | Ignora la caché y vuelve a leer los feeds |

## Agregar o quitar medios

Edita la lista `FUENTES` al inicio de `worker.js`. Para apagar una fuente sin borrarla, pon `activo: false`.

## Ajustar la clasificación

- `SECCIONES`: secciones de los medios (de la URL o de `<category>`) que deciden la categoría.
- `PALABRAS`: palabras clave por categoría (sin tildes, en minúsculas). El título cuenta doble.
- `VECINOS`: países y términos de Latinoamérica para separar "Vecinos" de "Mundo".

## Derechos de autor

Solo se usan el titular, el extracto que el medio publica en su RSS y el enlace a la nota original. Nunca el texto completo.
