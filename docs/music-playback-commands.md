# Comandos de música en el chat de Lumi (`/music`, `/play`, `/reproduce`)

Ponen una canción o un artista en **YouTube**, en el navegador del equipo del usuario, mediante
**Lumia Desktop Agent**. Usan el reproductor oficial de YouTube (la página web normal): no se extrae
audio ni se usa ninguna API no oficial.

## Flujo

```
Lumia Admin (chat) ──«/music Numb Linkin Park»──► BFF /api/admin/lumi/chat/stream
  └► Server: turno de Lumi → regla de `device.play_music` (sin modelo)
       ├─ permiso desktop.browser.control
       ├─ equipo propio conectado con browser.navigate / snapshot / click
       ├─ ¿aprobado «abrir y pulsar en las páginas de www.youtube.com» en ese equipo?
       │     no → tarjeta de confirmación («sí» / «sí, no vuelvas a preguntar» / «no»)
       └─ ejecución firmada en el agente (servicio de ejecuciones):
            1. browser.navigate  https://www.youtube.com/results?search_query=…
            2. browser.snapshot  (lee los enlaces de resultados)
            3. browser.click     en el vídeo cuyo nombre contiene la mayoría de las palabras pedidas
            4. comprueba que el navegador quedó en /watch (o /shorts) de www.youtube.com
```

Es la herramienta `device.play_music` de `src/modules/lumi/tools/desktop.tools.ts`: comparte la
selección de equipo, las confirmaciones por tipo y destino y los textos de error con las demás
herramientas de equipo.

## Respuestas (solo lo comprobado)

| Caso | Texto |
|---|---|
| Vídeo abierto y comprobado | «Puse «…» en YouTube en «PC». YouTube debería empezar a reproducirlo; si el navegador lo bloquea, pulsa reproducir en el equipo.» |
| Click sin cambio comprobable | «Pulsé «…» …, pero no pude comprobar que se abriera el vídeo. Revísalo en el equipo.» |
| Ningún resultado coincide | «Abrí la búsqueda de «…» … pero no encontré un vídeo que coincida para ponerlo. Elige uno en el equipo.» |
| YouTube redirige a otra página (p. ej. aviso de cookies) | No se pulsa nada; se dice en qué página quedó |
| Sin equipo, desconectado, en pausa, sin navegador | El mismo texto que el resto de herramientas de equipo |

Nunca dice que «suena»: el agente no puede comprobar el audio, solo que el vídeo quedó abierto.

## Aprobaciones

«sí, no vuelvas a preguntar» guarda las aprobaciones `open_page` y `click_page` de `www.youtube.com`
para ese equipo (no hay un tipo de aprobación propio). Se retiran en Lumia Admin → Dispositivos.

## Historia

La primera versión (2026-11-24) añadía `POST /admin/lumi/music/play`: un endpoint SSE que mostraba
pasos fijos («Abriendo navegador…», «Verificando reproducción…») y respondía `success: true` **sin
enviar nada al agente**, y que solo exigía `lumi.use`. Se retiró: los comandos van ahora por el turno
normal del chat, con los permisos, la confirmación, el historial y la verificación del agente.
